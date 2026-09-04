import {
  EMPTY,
  Observable,
  Subject,
  Subscription,
  asyncScheduler,
  catchError,
  concatMap,
  defer,
  exhaustMap,
  filter,
  finalize,
  from,
  map,
  mergeMap,
  observeOn,
  of,
  queueScheduler,
  switchMap,
  take,
  tap,
  throwError,
  timeout,
  timer,
} from 'rxjs';
import type { MonoTypeOperatorFunction, ObservableInput, OperatorFunction, Subscriber } from 'rxjs';
import { RslError, StateError, errorOutput, matchesError } from './errors.ts';
import { compileTest, resolveKey, resolveRef, resolveResource } from './evaluate.ts';
import type { RuntimeFn } from './evaluate.ts';
import { getPath, setPath } from './paths.ts';
import type { CompileArgs } from './registry.ts';
import { OUTPUT } from './trace.ts';
import type { CancelReason, DropPolicy, Token, TraceBase, TraceEvent } from './trace.ts';
import type { Catcher, Concurrency, Registry, Retrier, RslMachine, RslState, Shaping } from './types.ts';
import { assertValid } from './validate.ts';

/**
 * The RSL runtime (spec §9): one Subject per state, wiring by subscription,
 * errors resolved per token, completion by alive-token counting.
 *
 * Implemented: Pass, Task, Choice, Succeed, Fail, the four shaping policies,
 * `OnError`, and the JSONPath subset. Wait, Parallel and Map are rejected at
 * compile time until their slices land.
 *
 * Two phases. `planMachine` runs once per `compile`: validation, registry
 * resolution, and for a Task whose Resource is a machine, the nested plan.
 * `runMachine` runs once per subscription and owns the counters, the inboxes
 * and the reporting; a nested machine is run through it per token.
 */

export interface CompileOptions {
  /** Called for everything that happens to a token at a state (`src/rsl/trace.ts`, spec §9). */
  trace?: (event: TraceEvent) => void;
  /** Called when `OnError: "drop"` ends a token because of an error. */
  onDrop?: (error: unknown, token: Token) => void;
}

type OnError = 'fail' | 'drop';

const IMPLEMENTED: ReadonlySet<RslState['Type']> = new Set(['Pass', 'Task', 'Choice', 'Succeed', 'Fail']);

interface Plan {
  readonly startAt: string;
  readonly onError: OnError;
  readonly nodes: readonly Node[];
}

interface Step {
  readonly value: unknown;
  readonly target: string;
}

interface NodeBase {
  readonly name: string;
  readonly shaping: Shaping;
  readonly keep: RuntimeFn<boolean> | undefined;
  readonly key: RuntimeFn<unknown> | undefined;
}

/** Pass, Choice, Succeed, Fail: synchronous work. `step` may throw; the caller resolves the error per token. */
interface SyncNode extends NodeBase {
  readonly kind: 'sync';
  readonly step: (raw: unknown) => Step;
}

interface TaskNode extends NodeBase {
  readonly kind: 'task';
  readonly task: TaskPlan;
}

type Node = SyncNode | TaskNode;

type TaskResource =
  | { readonly kind: 'fn'; readonly fn: RuntimeFn<ObservableInput<unknown>> }
  | { readonly kind: 'machine'; readonly plan: Plan; readonly location: string };

interface TaskPlan {
  readonly resource: TaskResource;
  readonly concurrency: Concurrency;
  /** `Infinity` when unlimited. */
  readonly maxConcurrency: number;
  readonly take: number | undefined;
  readonly timeoutMs: number | undefined;
  readonly retriers: readonly Retrier[];
  readonly catchers: readonly Catcher[];
  readonly inputPath: string | undefined;
  readonly resultPath: string | undefined;
  readonly outputPath: string | undefined;
  readonly target: string;
}

interface Routed {
  readonly token: Token;
  readonly target: string;
}

type Drop = (token: Token, policy: DropPolicy) => void;
type Fail = (error: unknown, token: Token) => void;
type Cancel = (token: Token, reason: CancelReason) => void;

/** One subscription's runtime: counters, reporting and the per-state callbacks, shared by every node of the run. */
interface Run {
  readonly options: CompileOptions;
  report(event: TraceEvent): void;
  base(state: string, token: Token): TraceBase;
  /** A token is in flight: a source value, or an output leaving a Task. */
  start(): void;
  /** A token ended, however it ended. */
  end(): void;
  fail(state: string): Fail;
  drop(state: string): Drop;
  cancel(state: string): Cancel;
  /** True once the subscriber has unsubscribed; in-flight work then ends as `cancel` with reason `unsubscribe`. */
  tornDown(): boolean;
}

/**
 * Compile a document into an RxJS operator: the stream entering `StartAt` in,
 * the terminal-state values out. With a document written via `defineMachine`
 * the registry is required exactly when the document references names, and
 * every referenced name must be present in the right bucket (`registry.ts`).
 * A document typed as plain `RslMachine` takes an optional, untyped `Registry`.
 *
 * `NoInfer` matters: `M` must come from `machine` alone. Letting the compiler
 * infer it from a registry typed as `RegistryFor<…>` sends it through the
 * name-extraction conditionals and ends in "type instantiation is excessively deep".
 */
export function compile<I = unknown, O = unknown, M extends RslMachine = RslMachine>(
  machine: M,
  ...args: NoInfer<CompileArgs<M, CompileOptions>>
): OperatorFunction<I, O> {
  const [registry = {}, options = {}] = args as unknown as [Registry?, CompileOptions?];
  const plan = planMachine(machine, registry, 'fail');
  return (source$) =>
    new Observable<O>((subscriber) => runMachine(plan, source$, options, subscriber as Subscriber<unknown>));
}

// --- running (per subscription) ---------------------------------------------

function runMachine(
  plan: Plan,
  source$: Observable<unknown>,
  options: CompileOptions,
  subscriber: Subscriber<unknown>,
): Subscription {
  const inbox = new Map(plan.nodes.map((node) => [node.name, new Subject<Token>()] as const));
  const subs = new Subscription();
  let tornDown = false;
  // First finalizer, so the node teardowns below can tell unsubscription from a switch.
  subs.add(() => {
    tornDown = true;
  });
  let nextId = 0;
  let alive = 0;
  let sourceDone = false;

  const checkDone = (): void => {
    if (sourceDone && alive === 0) subscriber.complete();
  };
  const run: Run = {
    options,
    report: (event) => {
      options.trace?.(event);
    },
    base: (state, token) => ({ run: '', state, tokenId: token.id, value: token.value, at: asyncScheduler.now() }),
    start: () => {
      alive += 1;
    },
    end: () => {
      alive -= 1;
      checkDone();
    },
    fail: (state) => (error, token) => {
      run.report({ ...run.base(state, token), kind: 'error', error, onError: plan.onError });
      if (plan.onError === 'drop') {
        options.onDrop?.(error, token);
        run.end();
      } else {
        subscriber.error(error);
      }
    },
    drop: (state) => (token, policy) => {
      run.report({ ...run.base(state, token), kind: 'drop', policy });
      run.end();
    },
    cancel: (state) => (token, reason) => {
      run.report({ ...run.base(state, token), kind: 'cancel', reason });
    },
    tornDown: () => tornDown,
  };
  const send = (target: string, token: Token): void => {
    run.report({ ...run.base(target, token), kind: 'in' });
    inbox.get(target)!.next(token);
  };
  const emit = (token: Token): void => {
    subscriber.next(token.value);
    run.end();
  };

  for (const node of plan.nodes) {
    const drop = run.drop(node.name);
    const fail = run.fail(node.name);
    const cancel = run.cancel(node.name);
    const work = node.kind === 'sync' ? syncWork(node, run, fail) : taskWork(node, run, drop, fail, cancel);
    const node$ = inbox.get(node.name)!.pipe(observeOn(queueScheduler), shape(node, drop, fail, cancel), work);
    subs.add(node$.subscribe(({ token, target }) => (target === OUTPUT ? emit(token) : send(target, token))));
  }

  subs.add(
    source$.subscribe({
      next: (value) => {
        run.start();
        send(plan.startAt, { id: nextId++, value, enteredAt: asyncScheduler.now() });
      },
      error: (error: unknown) => subscriber.error(error),
      complete: () => {
        sourceDone = true;
        checkDone();
      },
    }),
  );

  return subs;
}

function syncWork(node: SyncNode, run: Run, fail: Fail): OperatorFunction<Token, Routed> {
  return mergeMap((token): Observable<Routed> => {
    try {
      const { value, target } = node.step(token.value);
      const out: Token = { id: token.id, value, enteredAt: token.enteredAt };
      run.report({ ...run.base(node.name, out), kind: 'out', target });
      return of({ token: out, target });
    } catch (error) {
      fail(error, token);
      return EMPTY;
    }
  });
}

/**
 * Spec §3: `flatten(Concurrency)(t => defer(() => from(resource(t))).pipe(timeout, retry, take, catchError))`.
 * Every input token is ended exactly once, when its projection settles or is cancelled;
 * every value the resource emits starts a new token, routed like any other output.
 */
function taskWork(node: TaskNode, run: Run, drop: Drop, fail: Fail, cancel: Cancel): OperatorFunction<Token, Routed> {
  const { task } = node;
  const project = (token: Token): Observable<Routed> =>
    defer(() => {
      let settled = false;
      let ended = false;
      const uncaught = (error: unknown): void => {
        ended = true; // `fail` ends the token (drop) or the whole run (fail)
        fail(error, token);
      };
      return runTask(node, token, run, uncaught).pipe(
        tap({
          complete: () => {
            settled = true;
          },
        }),
        finalize(() => {
          if (ended) return;
          if (!settled) cancel(token, run.tornDown() ? 'unsubscribe' : 'switch');
          run.end();
        }),
      );
    });

  switch (task.concurrency) {
    case 'merge':
      return mergeMap(project, task.maxConcurrency);
    case 'concat':
      return concatMap(project);
    case 'switch':
      return switchMap(project);
    case 'exhaust': {
      let busy = false;
      return (source) =>
        source.pipe(
          filter((token) => {
            if (!busy) return true;
            drop(token, 'Concurrency');
            return false;
          }),
          exhaustMap((token) =>
            defer(() => {
              busy = true;
              return project(token);
            }).pipe(
              finalize(() => {
                busy = false;
              }),
            ),
          ),
        );
    }
  }
}

/** One token through a Task: resource → timeout → per-Retrier retry → take → outputs, or a Catcher, or `uncaught`. Never errors. */
function runTask(node: TaskNode, token: Token, run: Run, uncaught: (error: unknown) => void): Observable<Routed> {
  const { task } = node;
  const { resource } = task;
  const input = select(token.value, task.inputPath);
  const attempts = task.retriers.map(() => 0);

  const invoke = (): Observable<unknown> => {
    const resource$ =
      resource.kind === 'fn' ? defer(() => from(resource.fn(input))) : runNested(resource, input, token, run);
    return task.timeoutMs === undefined ? resource$ : resource$.pipe(timeout({ first: task.timeoutMs }));
  };
  const attempt = (): Observable<unknown> =>
    invoke().pipe(
      catchError((error: unknown) => {
        const index = task.retriers.findIndex((retrier) => matchesError(retrier.ErrorEquals, error));
        if (index < 0) return throwError(() => error);
        const retrier = task.retriers[index];
        const count = attempts[index] + 1;
        if (count > (retrier.MaxAttempts ?? 3)) return throwError(() => error);
        attempts[index] = count;
        run.report({ ...run.base(node.name, token), kind: 'retry', attempt: count, error });
        const seconds = Math.min(
          (retrier.IntervalSeconds ?? 1) * (retrier.BackoffRate ?? 2) ** (count - 1),
          retrier.MaxDelaySeconds ?? Infinity,
        );
        return timer(seconds * 1000).pipe(mergeMap(() => attempt()));
      }),
    );

  const results$ = task.take === undefined ? attempt() : attempt().pipe(take(task.take));
  return results$.pipe(
    map((result): Routed => {
      const value = select(setPath(token.value, task.resultPath ?? '$', result), task.outputPath);
      const out: Token = { id: token.id, value, enteredAt: token.enteredAt };
      run.start();
      run.report({ ...run.base(node.name, out), kind: 'out', target: task.target });
      return { token: out, target: task.target };
    }),
    catchError((error: unknown): Observable<Routed> => {
      const catcher = task.catchers.find((candidate) => matchesError(candidate.ErrorEquals, error));
      if (catcher === undefined) {
        uncaught(error);
        return EMPTY;
      }
      const value = setPath(token.value, catcher.ResultPath ?? '$', errorOutput(error));
      const out: Token = { id: token.id, value, enteredAt: token.enteredAt };
      run.start();
      run.report({ ...run.base(node.name, out), kind: 'catch', error, target: catcher.Next });
      return of({ token: out, target: catcher.Next });
    }),
  );
}

/** A nested machine as Resource: one run per token, its events prefixed with the location and the outer token id (spec §9). */
function runNested(
  resource: Extract<TaskResource, { kind: 'machine' }>,
  input: unknown,
  token: Token,
  run: Run,
): Observable<unknown> {
  const location = `${resource.location}#${token.id}`;
  const options: CompileOptions = {
    trace: (event) => run.report({ ...event, run: event.run === '' ? location : `${location}/${event.run}` }),
    onDrop: run.options.onDrop,
  };
  return new Observable<unknown>((subscriber) => runMachine(resource.plan, of(input), options, subscriber));
}

// --- planning (compile time) -------------------------------------------------

/** Structure first (`assertValid`, spec §14), then registry resolution; both fail here rather than per token. */
function planMachine(machine: RslMachine, registry: Registry, inherited: OnError): Plan {
  assertValid(machine);
  const onError = machine.OnError ?? inherited;
  return {
    startAt: machine.StartAt,
    onError,
    nodes: Object.entries(machine.States).map(([name, state]) => planState(name, state, registry, onError)),
  };
}

function planState(name: string, state: RslState, registry: Registry, onError: OnError): Node {
  const where = `State "${name}"`;
  if (!IMPLEMENTED.has(state.Type)) {
    throw new RslError(
      `${where}: Type "${state.Type}" is not implemented in this runtime yet (implemented: Pass, Task, Choice, Succeed, Fail)`,
    );
  }
  const keep = state.Filter === undefined ? undefined : compileTest(state.Filter, registry, `${where} Filter`);
  const key =
    state.DistinctUntilChanged === undefined
      ? undefined
      : resolveKey(state.DistinctUntilChanged, registry, `${where} DistinctUntilChanged`);
  const base: NodeBase = { name, shaping: state, keep, key };

  switch (state.Type) {
    case 'Pass': {
      const transform =
        state.Transform === undefined
          ? undefined
          : resolveRef(state.Transform, registry.transforms, 'transform', `${where} Transform`);
      const target = state.Next ?? OUTPUT;
      const { InputPath, OutputPath, ResultPath, Result } = state;
      return {
        ...base,
        kind: 'sync',
        step: (raw) => {
          const input = select(raw, InputPath);
          const result = transform ? transform(input) : Result !== undefined ? Result : input;
          return { value: select(setPath(raw, ResultPath ?? '$', result), OutputPath), target };
        },
      };
    }
    case 'Task': {
      const resolved = resolveResource(state.Resource, registry, `${where} Resource`);
      const resource: TaskResource =
        typeof resolved === 'function'
          ? { kind: 'fn', fn: resolved }
          : { kind: 'machine', plan: planMachine(resolved, registry, onError), location: `States.${name}.Resource` };
      return {
        ...base,
        kind: 'task',
        task: {
          resource,
          concurrency: state.Concurrency ?? 'merge',
          maxConcurrency: state.MaxConcurrency ? state.MaxConcurrency : Infinity,
          take: state.Take,
          timeoutMs: state.TimeoutSeconds === undefined ? undefined : state.TimeoutSeconds * 1000,
          retriers: state.Retry ?? [],
          catchers: state.Catch ?? [],
          inputPath: state.InputPath,
          resultPath: state.ResultPath,
          outputPath: state.OutputPath,
          target: state.Next ?? OUTPUT,
        },
      };
    }
    case 'Succeed': {
      const { InputPath, OutputPath } = state;
      return {
        ...base,
        kind: 'sync',
        step: (raw) => ({ value: select(select(raw, InputPath), OutputPath), target: OUTPUT }),
      };
    }
    case 'Fail': {
      const errorName = state.Error ?? 'States.Fail';
      const cause = state.Cause;
      return {
        ...base,
        kind: 'sync',
        step: () => {
          throw new StateError(errorName, cause);
        },
      };
    }
    case 'Choice': {
      const rules = state.Choices.map((rule, index) => ({
        test: compileTest(rule, registry, `${where} Choices[${index}]`),
        target: rule.Next,
      }));
      const fallback = state.Default;
      const { InputPath, OutputPath } = state;
      return {
        ...base,
        kind: 'sync',
        step: (raw) => {
          const input = select(raw, InputPath);
          const value = select(input, OutputPath);
          for (const rule of rules) if (rule.test(input)) return { value, target: rule.target };
          if (fallback !== undefined) return { value, target: fallback };
          throw new StateError('States.NoChoiceMatched', `${where}: no rule matched and no Default is set`);
        },
      };
    }
    default:
      throw new RslError(`${where}: Type "${state.Type}" is not implemented`);
  }
}

function select(value: unknown, path: string | undefined): unknown {
  return path === undefined ? value : getPath(value, path);
}

// --- input shaping (run time) ------------------------------------------------

/** Spec §4: Filter, then Debounce, then Throttle, then DistinctUntilChanged. Every suppressed token is reported. */
function shape(node: Node, drop: Drop, fail: Fail, cancel: Cancel): MonoTypeOperatorFunction<Token> {
  const ops: MonoTypeOperatorFunction<Token>[] = [];
  if (node.keep) ops.push(keepTokens(node.keep, drop, fail));
  if (node.shaping.Debounce !== undefined) ops.push(debounceTokens(node.shaping.Debounce, drop, cancel));
  if (node.shaping.Throttle !== undefined) ops.push(throttleTokens(node.shaping.Throttle, drop));
  if (node.key) ops.push(distinctTokens(node.key, drop, fail));
  return (source) => ops.reduce((stream, op) => op(stream), source);
}

function keepTokens(keep: RuntimeFn<boolean>, drop: Drop, fail: Fail): MonoTypeOperatorFunction<Token> {
  return filter((token) => {
    let ok: boolean;
    try {
      ok = keep(token.value);
    } catch (error) {
      fail(error, token);
      return false;
    }
    if (!ok) drop(token, 'Filter');
    return ok;
  });
}

function distinctTokens(key: RuntimeFn<unknown>, drop: Drop, fail: Fail): MonoTypeOperatorFunction<Token> {
  return (source) => {
    let seen = false;
    let last: unknown;
    return source.pipe(
      filter((token) => {
        let current: unknown;
        try {
          current = key(token.value);
        } catch (error) {
          fail(error, token);
          return false;
        }
        if (seen && Object.is(current, last)) {
          drop(token, 'DistinctUntilChanged');
          return false;
        }
        seen = true;
        last = current;
        return true;
      }),
    );
  };
}

/** Leading-edge throttle: the first token opens a window of `ms`; tokens inside the window are dropped. */
function throttleTokens(ms: number, drop: Drop): MonoTypeOperatorFunction<Token> {
  return (source) => {
    let windowStart: number | undefined;
    return source.pipe(
      filter((token) => {
        const now = asyncScheduler.now();
        if (windowStart === undefined || now - windowStart >= ms) {
          windowStart = now;
          return true;
        }
        drop(token, 'Throttle');
        return false;
      }),
    );
  };
}

/**
 * Like `debounceTime`, but a superseded token is dropped the moment its
 * successor arrives, and a token still pending at teardown is reported as cancelled.
 */
function debounceTokens(ms: number, drop: Drop, cancel: Cancel): MonoTypeOperatorFunction<Token> {
  return (source) =>
    new Observable<Token>((subscriber) => {
      let pending: Token | undefined;
      let timer: Subscription | undefined;
      const subscription = source.subscribe({
        next: (token) => {
          if (pending) drop(pending, 'Debounce');
          pending = token;
          timer?.unsubscribe();
          timer = asyncScheduler.schedule(() => {
            const due = pending;
            pending = undefined;
            timer = undefined;
            if (due) subscriber.next(due);
          }, ms);
        },
        error: (error: unknown) => subscriber.error(error),
        complete: () => subscriber.complete(),
      });
      return () => {
        subscription.unsubscribe();
        timer?.unsubscribe();
        if (pending) cancel(pending, 'unsubscribe');
      };
    });
}
