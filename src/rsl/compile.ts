import {
  EMPTY,
  Observable,
  Subject,
  Subscription,
  asyncScheduler,
  filter,
  mergeMap,
  observeOn,
  of,
  queueScheduler,
} from 'rxjs';
import type { MonoTypeOperatorFunction, OperatorFunction } from 'rxjs';
import { RslError, StateError } from './errors.ts';
import { compileTest, resolveKey, resolveRef } from './evaluate.ts';
import { getPath, setPath } from './paths.ts';
import type { KeyFn, PredicateFn, Registry, RslMachine, RslState, Shaping } from './types.ts';
import { assertValid } from './validate.ts';

/**
 * The RSL runtime (spec §9): one Subject per state, wiring by subscription,
 * errors resolved per token, completion by alive-token counting.
 *
 * Implemented in this slice: Pass, Choice, Succeed, Fail, the four shaping
 * policies, `OnError`, and the JSONPath subset. Task, Wait, Parallel and Map
 * are rejected at compile time until their slices land.
 */

/** A value travelling through a machine. `id` and `enteredAt` survive transformations. */
export interface Token {
  readonly id: number;
  readonly value: unknown;
  readonly enteredAt: number;
}

export type TraceKind = 'in' | 'out' | 'drop' | 'error';

export interface TraceEvent {
  readonly state: string;
  readonly kind: TraceKind;
  readonly tokenId: number;
  readonly value: unknown;
  readonly at: number;
}

export interface CompileOptions {
  /** Called for every token entering or leaving a state, and for drops and errors. */
  trace?: (event: TraceEvent) => void;
  /** Called when `OnError: "drop"` ends a token because of an error. */
  onDrop?: (error: unknown, token: Token) => void;
}

const OUTPUT = '$output';
const IMPLEMENTED: ReadonlySet<RslState['Type']> = new Set(['Pass', 'Choice', 'Succeed', 'Fail']);

interface Step {
  readonly value: unknown;
  readonly target: string;
}

interface Node {
  readonly name: string;
  readonly shaping: Shaping;
  readonly keep: PredicateFn | undefined;
  readonly key: KeyFn | undefined;
  /** The state's synchronous work. May throw; the caller resolves the error per token. */
  readonly step: (raw: unknown) => Step;
}

interface Routed {
  readonly token: Token;
  readonly target: string;
}

type Drop = (token: Token) => void;
type Fail = (error: unknown, token: Token) => void;

/** Compile a document into an RxJS operator: the stream entering `StartAt` in, the terminal-state values out. */
export function compile<I, O>(
  machine: RslMachine,
  registry: Registry = {},
  options: CompileOptions = {},
): OperatorFunction<I, O> {
  const nodes = planMachine(machine, registry);
  const onError = machine.OnError ?? 'fail';

  return (source$) =>
    new Observable<O>((subscriber) => {
      const inbox = new Map(nodes.map((node) => [node.name, new Subject<Token>()] as const));
      const subs = new Subscription();
      let nextId = 0;
      let alive = 0;
      let sourceDone = false;

      const trace = (state: string, kind: TraceKind, token: Token): void => {
        options.trace?.({ state, kind, tokenId: token.id, value: token.value, at: asyncScheduler.now() });
      };
      const checkDone = (): void => {
        if (sourceDone && alive === 0) subscriber.complete();
      };
      const end = (): void => {
        alive -= 1;
        checkDone();
      };
      const send = (target: string, token: Token): void => {
        trace(target, 'in', token);
        inbox.get(target)!.next(token);
      };
      const emit = (token: Token): void => {
        subscriber.next(token.value as O);
        end();
      };
      const dropAt =
        (state: string): Drop =>
        (token) => {
          trace(state, 'drop', token);
          end();
        };
      const failAt =
        (state: string): Fail =>
        (error, token) => {
          if (onError === 'drop') {
            trace(state, 'drop', token);
            options.onDrop?.(error, token);
            end();
          } else {
            trace(state, 'error', token);
            subscriber.error(error);
          }
        };

      for (const node of nodes) {
        const drop = dropAt(node.name);
        const fail = failAt(node.name);
        const node$ = inbox.get(node.name)!.pipe(
          observeOn(queueScheduler),
          shape(node, drop, fail),
          mergeMap((token): Observable<Routed> => {
            try {
              const { value, target } = node.step(token.value);
              const out: Token = { id: token.id, value, enteredAt: token.enteredAt };
              trace(node.name, 'out', out);
              return of({ token: out, target });
            } catch (error) {
              fail(error, token);
              return EMPTY;
            }
          }),
        );
        subs.add(node$.subscribe(({ token, target }) => (target === OUTPUT ? emit(token) : send(target, token))));
      }

      subs.add(
        source$.subscribe({
          next: (value) => {
            alive += 1;
            send(machine.StartAt, { id: nextId++, value, enteredAt: asyncScheduler.now() });
          },
          error: (error: unknown) => subscriber.error(error),
          complete: () => {
            sourceDone = true;
            checkDone();
          },
        }),
      );

      return subs;
    });
}

// --- planning (compile time) -------------------------------------------------

/** Structure first (`assertValid`, spec §14), then registry resolution; both fail here rather than per token. */
function planMachine(machine: RslMachine, registry: Registry): Node[] {
  assertValid(machine);
  return Object.entries(machine.States).map(([name, state]) => planState(name, state, registry));
}

function planState(name: string, state: RslState, registry: Registry): Node {
  const where = `State "${name}"`;
  if (!IMPLEMENTED.has(state.Type)) {
    throw new RslError(
      `${where}: Type "${state.Type}" is not implemented in this runtime yet (implemented: Pass, Choice, Succeed, Fail)`,
    );
  }
  const keep = state.Filter === undefined ? undefined : compileTest(state.Filter, registry, `${where} Filter`);
  const key =
    state.DistinctUntilChanged === undefined
      ? undefined
      : resolveKey(state.DistinctUntilChanged, registry, `${where} DistinctUntilChanged`);
  const base = { name, shaping: state, keep, key };

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
        step: (raw) => {
          const input = select(raw, InputPath);
          const result = transform ? transform(input) : Result !== undefined ? Result : input;
          return { value: select(setPath(raw, ResultPath ?? '$', result), OutputPath), target };
        },
      };
    }
    case 'Succeed': {
      const { InputPath, OutputPath } = state;
      return { ...base, step: (raw) => ({ value: select(select(raw, InputPath), OutputPath), target: OUTPUT }) };
    }
    case 'Fail': {
      const errorName = state.Error ?? 'States.Fail';
      const cause = state.Cause;
      return {
        ...base,
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
function shape(node: Node, drop: Drop, fail: Fail): MonoTypeOperatorFunction<Token> {
  const ops: MonoTypeOperatorFunction<Token>[] = [];
  if (node.keep) ops.push(keepTokens(node.keep, drop, fail));
  if (node.shaping.Debounce !== undefined) ops.push(debounceTokens(node.shaping.Debounce, drop));
  if (node.shaping.Throttle !== undefined) ops.push(throttleTokens(node.shaping.Throttle, drop));
  if (node.key) ops.push(distinctTokens(node.key, drop, fail));
  return (source) => ops.reduce((stream, op) => op(stream), source);
}

function keepTokens(keep: PredicateFn, drop: Drop, fail: Fail): MonoTypeOperatorFunction<Token> {
  return filter((token) => {
    let ok: boolean;
    try {
      ok = keep(token.value);
    } catch (error) {
      fail(error, token);
      return false;
    }
    if (!ok) drop(token);
    return ok;
  });
}

function distinctTokens(key: KeyFn, drop: Drop, fail: Fail): MonoTypeOperatorFunction<Token> {
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
          drop(token);
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
        drop(token);
        return false;
      }),
    );
  };
}

/** Like `debounceTime`, but a superseded token is dropped the moment its successor arrives. */
function debounceTokens(ms: number, drop: Drop): MonoTypeOperatorFunction<Token> {
  return (source) =>
    new Observable<Token>((subscriber) => {
      let pending: Token | undefined;
      let timer: Subscription | undefined;
      const subscription = source.subscribe({
        next: (token) => {
          if (pending) drop(pending);
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
      };
    });
}
