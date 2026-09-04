# RSL — Reactive States Language (v0 draft)

RSL = ASL topology + RxJS execution policies. A declarative language describing how values move through a reactive workflow over time.

ASL (AWS Step Functions' Amazon States Language) runs exactly one execution per input value. It has no answer to "a second value arrived while the first is still running" (cancel? queue? ignore? run both?), no timing operators, no cancellation, and one output per state. Those are precisely the things RxJS is about. RSL keeps every ASL topology construct unchanged and adds a small, fixed vocabulary of **policies** for the time dimension.

The TypeScript schema lives in `src/rsl/types.ts` and the JSON Schema for JSON/YAML documents in `rsl.schema.json`; `src/rsl/validate.ts` checks the graph rules neither can express (§14); the examples below are type-checked in `src/rsl/examples.ts`; `src/rsl/diagram.ts` and `src/rsl/pipeview.ts` render any document (§13). The runtime (`compile`, `src/rsl/compile.ts`) implements the synchronous core: Pass, Choice, Succeed, Fail, the four shaping policies, `OnError`, the JSONPath subset, and the completion rule. Task, Wait, Parallel and Map are rejected at compile time until their slices land. §9 describes the model.

## 1. Definition

> An RSL document is an ASL state machine whose states are RxJS operators. The topology (`StartAt`, `Next`, `End`, `Choice`, `Parallel`, `Map`) says **where** a value goes. Policies say **when** it may go, **how many** may be in flight at once, and what happens when work **fails, hangs, or is superseded**.

Core model:

- **Token.** A value entering `StartAt` becomes a token. It moves along `Next` edges until it reaches a terminal state, is dropped by a policy, or errors.
- **State = operator.** Every state compiles to an RxJS `OperatorFunction<In, Out>`. Unlike ASL, a state may emit 0..n output tokens per input token, because a Task's `Resource` may return an Observable. ASL's "exactly one output" is the special case.
- **Machine = operator.** A machine compiles to `OperatorFunction<Input, Output>`: the stream entering `StartAt` in, the stream of values reaching `End`/`Succeed` out. Because a machine is an operator, machines nest: `Parallel.Branches[i]`, `Map.ItemProcessor`, and any `Task.Resource` may be a machine.

Semantics (the dataflow reading, which is also the runtime design): every state `n` has an input stream `in_n` = merge of the outputs of all states whose `Next` (or Choice rule, or Catch) targets `n`, plus the machine source when `n = StartAt`; and an output stream `out_n = in_n.pipe(shape_n, run_n)`. `shape_n` is the input-shaping policies, `run_n` is the state's Type plus execution policies. The machine's output is the merge of `out_n` over terminal states. Cycles (`Next` pointing back to an earlier state) are allowed; they make this a fixed-point system, which the runtime solves with one Subject per state.

## 2. Principles

1. **Superset of ASL topology.** Every ASL state type and transition field keeps its meaning. RSL never adds a new `Type`; it only adds fields. An ASL document with no RSL fields runs each input value as an independent ASL execution in data and timing (default `Concurrency: "merge"`). One qualification, inherited from RxJS: with the default `OnError: "fail"` an uncaught failure in one execution errors the whole output stream; set `OnError: "drop"` for full isolation.
2. **Everything is an operator.** State, machine, branch, item processor: all `OperatorFunction`. Composition is free.
3. **Multi-shot.** States and machines may emit many values per input. This is what makes "over time" real.
4. **Policies, not primitives.** RSL fields are flat PascalCase fields on the state, exactly like ASL's own execution policies (`Retry`, `Catch`, `TimeoutSeconds`, `MaxConcurrency`). Three families: **input shaping** (which arriving tokens get to run), **execution** (what happens to a token while it runs), **combination** (how several streams become one).
5. **RxJS semantics for time, cancellation, errors.** Unsubscribing the machine cancels all in-flight work. Errors are resolved per token (`Retry` → `Catch` → `OnError`); only `OnError: "fail"` reaches the subscriber.
6. **No expression evaluator in v0.** Resources, transforms, and predicates are registry names (JSON-portable) or inline functions (when authored in TS). ASL's structured Choice comparison rules and a JSONPath subset are supported for portability. JSONata (`{% … %}` strings, `QueryLanguage: "JSONata"`) is reserved: recognised and rejected with a clear error, not evaluated.
7. **Renderable.** The document is data, so the topology, the policies, and each state's RxJS pipe can be drawn without running anything (§13). Prefer registry names over inline functions wherever a diagram matters.

## 3. State types → RxJS

| Type | RxJS core | ASL fields kept (v0) | RSL policies allowed |
|---|---|---|---|
| **Pass** | `map` | `Result`, `ResultPath`, `InputPath`, `OutputPath` | shaping; `Transform` |
| **Task** | `flatten(Concurrency)(t => defer(() => from(resource(t))).pipe(timeout({ first }), retry, take, catchError))` | `Resource`, `TimeoutSeconds`, `Retry`, `Catch`, `InputPath`, `ResultPath`, `OutputPath` | shaping; `Concurrency`, `MaxConcurrency`, `Take` |
| **Wait** | `mergeMap(t => timer(due(t)).pipe(map(() => t)))`; `due` reads `Seconds`/`Timestamp` or the per-token `SecondsPath`/`TimestampPath` | `Seconds`, `Timestamp`, `SecondsPath`, `TimestampPath` (mutually exclusive) | shaping |
| **Choice** | routing: first matching rule wins, else `Default`, else error `States.NoChoiceMatched` | `Choices`, `Default`, JSONPath-mode data-test rules, `Condition` | shaping |
| **Parallel** | `flatten(Concurrency)(t => join(Join)(Branches.map(b => b(of(t)))))` | `Branches`, `ResultPath`, `Retry`, `Catch` | shaping; `Concurrency`, `Join` |
| **Map** | `flatten(Concurrency)(t => from(items(t)).pipe(mergeMap((item, i) => processor(of(item)), max), collect))` | `ItemsPath`, `ItemProcessor`, `MaxConcurrency`, `ResultPath`, `Retry`, `Catch` | shaping; `Concurrency`, `Collect` |
| **Succeed** | emit token on machine output | — | shaping |
| **Fail** | per-token error `{ Error, Cause }` → `OnError` | `Error`, `Cause` | shaping |

`End: true` on a Pass/Task/Wait/Parallel/Map behaves like Succeed for that token. Choice, Succeed and Fail take neither `Next` nor `End` (Choice routes via its rules). Pass and Choice are synchronous. Wait deliberately has no `Concurrency` in v0 because `switch`/`exhaust` on a Wait would just be `debounceTime`/`throttleTime` under another name.

A Choice cannot *drop* a token: every rule routes somewhere, and there is no discard terminal. Dropping by value is what the `Filter` shaping policy is for.

## 4. Policy families

| Family | Question it answers | Fields | RxJS |
|---|---|---|---|
| Input shaping | Which of the tokens arriving at this state get to run? | `Filter`, `Debounce`, `Throttle`, `DistinctUntilChanged` | `filter`, `debounceTime`, `throttleTime`, `distinctUntilChanged` |
| Execution | A token arrived while the previous one is still running: cancel, queue, ignore, or overlap? What if it hangs, fails, or never stops? | `Concurrency`, `MaxConcurrency`, `TimeoutSeconds`, `Retry`, `Catch`, `Take` | `switchMap`/`concatMap`/`exhaustMap`/`mergeMap`, `timeout`, `retry`, `catchError`, `take` |
| Combination | How do several streams become one token stream? | `Join` (Parallel), `Collect` (Map) | `forkJoin`/`combineLatest`/`zip`/`merge`/`race`, `toArray` |
| Machine | What happens to uncaught errors? | `OnError` | — |

Shaping policies apply to a state's inbox in a fixed order: `Filter`, then `Debounce`, then `Throttle`, then `DistinctUntilChanged`. (Filtering first is cheap and value-based; deduplicating after debouncing is the live-search idiom.)

## 5. RSL-specific field reference

| Field | On | Type | Default | Meaning |
|---|---|---|---|---|
| `Filter` | any state | data test \| registry predicate \| fn | — | `filter` on the state's inbox. A token that fails the test ends its life. The test is an ASL data test (`{ "Variable": "$", "NumericGreaterThan": 6 }`), a registry predicate name, or a function |
| `Debounce` | any state | ms | — | `debounceTime` on the state's inbox |
| `Throttle` | any state | ms | — | `throttleTime` (leading edge) on the inbox |
| `DistinctUntilChanged` | any state | `true` \| JSONPath (`$…`) \| key fn/name | — | `distinctUntilChanged` on the token **value**. `true` compares with `Object.is` (primitives; objects by reference); a `$`-path or key selects what to compare. Named after the operator on purpose: RxJS `distinct` is the all-time-set operator and is not what this does |
| `Concurrency` | Task, Parallel, Map | `"merge"` \| `"switch"` \| `"concat"` \| `"exhaust"` | `"merge"` | flattening strategy for successive tokens. `switch` cancels the in-flight one, `concat` queues until the current resource **completes**, `exhaust` ignores newcomers, `merge` overlaps |
| `MaxConcurrency` | Task (with merge), Map (inner, per item) | number, `0` = unlimited | `0` | ASL's Map field, reused for Task. The runtime maps `0` to `Infinity` (RxJS `mergeMap(fn, 0)` would never subscribe) |
| `Take` | Task | number | — | `take(n)` on the resource's output; `Take: 1` makes a multi-shot resource ASL-one-shot again |
| `Join` | Parallel | `"forkJoin"` \| `"combineLatest"` \| `"zip"` \| `"merge"` \| `"race"` | `"forkJoin"` | forkJoin/combineLatest/zip emit an array indexed by branch; merge/race emit single branch values |
| `Collect` | Map | `"array"` \| `"stream"` | `"array"` | `array`: one token holding each item's **last** result, in input order (indexed, then sorted; forkJoin-style: an item processor that completes empty makes the Map emit nothing). `stream`: one token per item result, as they complete |
| `Transform` | Pass | fn \| registry name | — | `(input) => output`; replaces ASL `Parameters` templating in v0 |
| `Condition` | Choice rule, `Filter` | fn \| registry name \| `{% … %}` | — | ASL's own field name kept. A `{% … %}` string is JSONata (reserved, rejected in v0); any other string is a registry predicate; a function when authored in TS |
| `OnError` | machine | `"fail"` \| `"drop"` | `"fail"` | uncaught error or Fail state: `fail` errors the output stream (RxJS semantics); `drop` ends that token only and reports it via the `onDrop` callback passed to `compile`. Nested machines inherit the enclosing value unless they set their own |

Defaults are deliberately ASL-faithful: no shaping, `merge`, `forkJoin`, `array`, `fail`.

`TimeoutSeconds` on Task is ASL's field with one clarification: it is `timeout({ first: ms })`, the time until the resource's **first** emission. Total-duration timeouts for multi-shot resources, and ASL's machine-level `TimeoutSeconds`, are deferred (§11).

## 6. Resolving resources, expressions, paths

- **`Resource`** (Task): a string is looked up in `registry.resources`; when a document is authored in TypeScript it may be the function itself, or a nested `RslMachine`. Signature `(input) => ObservableInput` (Promise, array, iterable, Observable are all accepted via `from`). The runtime wraps the call in `defer` so `Retry` re-invokes the resource instead of replaying a settled promise. ASL ARNs simply are not in the registry.
- **`Transform`, `Condition`, `Filter`, `DistinctUntilChanged` key**: string = name in `registry.transforms` / `registry.predicates` / `registry.keys`, or an inline function. Exceptions: a `DistinctUntilChanged` string starting with `$` is a JSONPath, and a `Condition` string wrapped in `{% %}` is reserved JSONata.
- **Choice rules and `Filter` tests**: ASL JSONPath-mode data tests, v0 subset: `Variable` + one of `StringEquals`, `StringLessThan`, `StringGreaterThan`, `NumericEquals`, `NumericLessThan`, `NumericGreaterThan`, `NumericLessThanEquals`, `NumericGreaterThanEquals`, `BooleanEquals`, `IsPresent`, `IsNull`; combinators `And`, `Or`, `Not`. Plus `Condition`.
- **Paths** (`InputPath`, `OutputPath`, `ResultPath`, `ItemsPath`, `Variable`, `SecondsPath`, `TimestampPath`): JSONPath subset `$`, `$.a.b`, `$.a[0]`. A 30-line getter/setter, no dependency. `ResultPath` keeps ASL semantics: the result is inserted into the *original* (pre-`InputPath`) input at that path (this is what lets a polling loop keep its job id, see §8).
- **ASL defaults kept**: Retrier `IntervalSeconds: 1`, `MaxAttempts: 3`, `BackoffRate: 2.0`; Catcher `ResultPath: "$"` (the error object replaces the input); Map `ItemsPath: "$"`; `States.ALL` must be the last Retrier/Catcher and alone in its `ErrorEquals`. Each Retrier keeps its own attempt counter per token, as in ASL.
- **Error names** (`ErrorEquals`): match `error.name`; `States.ALL` matches everything, `States.Timeout` matches RxJS `TimeoutError`.
- **Reserved, not implemented in v0**: `QueryLanguage` (only `"JSONPath"` accepted), `Assign`/variables, `Parameters`/`ResultSelector` templating, `Output` (JSONata form), `HeartbeatSeconds`, machine-level `TimeoutSeconds`.

## 7. Errors, cancellation, ordering, completion

- **Errors are resolved per token, inside the state's flattening projection.** A Task/Parallel/Map error goes through that state's `Retry`, then `Catch` (which turns the error into a token `{ Error, Cause }` at `ResultPath` and routes it to the Catcher's `Next`), then the machine's `OnError`. `drop` ends the token and calls `onDrop(error, token)`; `fail` errors the output stream. A node's own pipe therefore never errors under `drop`, and a `Fail` state keeps working after its first token. Inside a branch or item processor an uncaught error errors the sub-machine, which the enclosing Parallel/Map treats as its own error (subject to its Retry/Catch). All ASL-consistent.
- **Retry never retracts.** Retrying a multi-shot resource restarts it; values it already emitted downstream stay emitted.
- **Cancellation.** Unsubscribing from the machine unsubscribes every node: in-flight resources, pending Waits, debounce timers. `switch` cancels the state's *own* in-flight work only; tokens it already emitted downstream continue. Same as `switchMap`.
- **`concat` queues until completion.** A resource that never completes blocks the queue forever. Use `Take` or an Observable that completes.
- **Ordering.** No cross-machine ordering guarantee unless every async state uses `concat`. Map's `array` mode preserves item order regardless of `MaxConcurrency` (results are indexed and sorted).
- **Token end of life.** A token ends when it reaches `End`/`Succeed`, is suppressed by shaping (`Filter`, `Debounce`, `Throttle`, `DistinctUntilChanged`), is cancelled by `switch` or ignored by `exhaust`, is dropped by `OnError: "drop"`, or errors.
- **Completion.** The output completes when the source has completed **and** the machine's alive-token counter is zero (no in-flight resource, no pending Wait/debounce, no queued `concat` token, no token in an inbox). This one rule serves acyclic and cyclic machines alike; inbox Subjects are never completed individually. It is also what makes a branch machine complete after its single token finishes, which `forkJoin` depends on.
- **Synchronous cycles.** Inbox delivery goes through `observeOn(queueScheduler)` (trampolined: synchronous unless re-entered), so a Pass → Choice → Pass loop iterates instead of recursing through `Subject.next` and overflowing the stack.

## 8. Examples

All four are in `src/rsl/examples.ts` and rendered by the demo page (`npm run dev`).

### map + filter

The smallest possible pipeline:

```ts
from([1, 2, 3, 4, 5]).pipe(
  map((n) => n * 2),
  filter((n) => n > 6),
).subscribe((n) => console.log(n)); // 8, 10
```

The source stays outside the document, because a machine is an operator. `map` is a `Pass` with a `Transform`; `filter` is the `Filter` shaping policy on the state that follows it. Two operators, two states:

```json
{
  "Comment": "map(n => n * 2), then keep only n > 6",
  "StartAt": "Double",
  "States": {
    "Double": { "Type": "Pass", "Transform": "double", "Next": "Emit" },
    "Emit": { "Type": "Succeed", "Filter": { "Variable": "$", "NumericGreaterThan": 6 } }
  }
}
```

```ts
from([1, 2, 3, 4, 5])
  .pipe(compile(mapFilter, { transforms: { double: (n) => (n as number) * 2 } }))
  .subscribe((n) => console.log(n)); // 8, 10
```

Pipe view:

```
source → Double
Double: map(double) → Emit
Emit: filter($ > 6) → output
```

If the source must live in the document too, a `Pass` with a constant `Result` followed by a `Map` with `Collect: "stream"` is `from([...])` in RSL form: one trigger token in, five item tokens out.

### Live search

Input shaping + switch + timeout + retry + catch:

```json
{
  "Comment": "Wait for typing to settle, skip repeats, cancel stale requests, fall back on error",
  "StartAt": "Search",
  "States": {
    "Search": {
      "Type": "Task",
      "Resource": "searchApi",
      "Debounce": 300,
      "DistinctUntilChanged": true,
      "Concurrency": "switch",
      "TimeoutSeconds": 5,
      "Retry": [{ "ErrorEquals": ["States.Timeout"], "MaxAttempts": 2, "IntervalSeconds": 1, "BackoffRate": 2 }],
      "Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "Fallback" }],
      "End": true
    },
    "Fallback": { "Type": "Pass", "Result": { "results": [], "error": true }, "End": true }
  }
}
```

```ts
const search = compile<string, SearchResult>(liveSearch, {
  resources: { searchApi: (q) => fromFetch(`/api?q=${q}`).pipe(switchMap((r) => r.json())) },
});
query$.pipe(search).subscribe(render);
```

The RxJS it stands for (single Retrier shown):

```ts
query$.pipe(
  debounceTime(300),
  distinctUntilChanged(),
  switchMap((q) =>
    defer(() => from(searchApi(q))).pipe(
      timeout({ first: 5000 }),
      retry({ count: 2, delay: (err, n) => (err.name === 'TimeoutError' ? timer(1000 * 2 ** (n - 1)) : throwError(() => err)) }),
      catchError(() => of({ results: [], error: true })),
    ),
  ),
);
```

### Polling loop

A cycle, which is natural in ASL topology and awkward in a flat RxJS pipe:

```json
{
  "Comment": "Poll a job until it reports done, then emit { id, job }",
  "StartAt": "GetStatus",
  "States": {
    "GetStatus": { "Type": "Task", "Resource": "getJobStatus", "InputPath": "$.id", "ResultPath": "$.job", "Next": "IsDone" },
    "IsDone": {
      "Type": "Choice",
      "Choices": [{ "Variable": "$.job.status", "StringEquals": "done", "Next": "Finished" }],
      "Default": "Pause"
    },
    "Pause": { "Type": "Wait", "Seconds": 2, "Next": "GetStatus" },
    "Finished": { "Type": "Succeed" }
  }
}
```

Input `{ id }` → `GetStatus` calls the resource with `id` and stores the result at `$.job` → Choice reads `$.job.status` → loop. In raw RxJS this is `expand` or a hand-rolled `timer` + `takeWhile`. To poll only one job at a time, do **not** put `exhaust` on `GetStatus` (it would also swallow the loop's own feedback token); instead wrap this machine as a `Task` in an outer machine with `Concurrency: "exhaust"`. Machines compose, so that is one line.

### Parallel with a join policy

```json
{
  "Comment": "Load a user and their orders side by side, then merge",
  "StartAt": "LoadProfile",
  "States": {
    "LoadProfile": {
      "Type": "Parallel",
      "Join": "forkJoin",
      "Branches": [
        { "StartAt": "User",   "States": { "User":   { "Type": "Task", "Resource": "getUser",   "End": true } } },
        { "StartAt": "Orders", "States": { "Orders": { "Type": "Task", "Resource": "getOrders", "End": true } } }
      ],
      "Next": "Merge"
    },
    "Merge": { "Type": "Pass", "Transform": "toProfile", "End": true }
  }
}
```

= `mergeMap((id) => forkJoin([getUser(id), getOrders(id)]).pipe(map(toProfile)))`. Change `Join` to `"combineLatest"` and the branches may be live streams; the profile then re-emits whenever either side updates. That one field is the whole difference between a request and a subscription.

## 9. Runtime model

One Subject per state; wiring is subscriptions; unsubscribe tears everything down. Errors never travel on a node's outer pipe.

```ts
export function compile<I, O>(
  m: RslMachine,
  reg: Registry = {},
  opts: { trace?: (e: TraceEvent) => void; onDrop?: (error: unknown, token: Token) => void } = {},
): OperatorFunction<I, O> {
  return (source$) =>
    new Observable<O>((subscriber) => {
      const inbox = new Map(Object.keys(m.States).map((n) => [n, new Subject<Token>()]));
      const alive = counter(() => sourceDone && alive.count === 0 && subscriber.complete());
      let sourceDone = false;
      const subs = new Subscription();
      for (const [name, state] of Object.entries(m.States)) {
        subs.add(
          inbox.get(name)!
            .pipe(observeOn(queueScheduler), shape(state), run(state, reg, opts, alive)) // errors resolved inside run
            .subscribe(({ token, target }) => route(token, target, inbox, subscriber, alive)),
        );
      }
      subs.add(
        source$.subscribe({
          next: (v) => { alive.inc(); inbox.get(m.StartAt)!.next(newToken(v)); },
          error: (e) => subscriber.error(e),
          complete: () => { sourceDone = true; alive.check(); },
        }),
      );
      return subs; // unsubscribe = cancel everything in flight
    });
}
```

`run` emits `{ token, target }` where `target` is the state's `Next`, the first matching Choice rule's `Next`, a Catcher's `Next`, or `'$output'`; `route` pushes to the target inbox, or to the subscriber for `$output`, and decrements `alive` when a token ends. `run(Task)` = `flatten(Concurrency)((t) => defer(() => from(resource(t))).pipe(timeout({ first }), retryPerRetrier(state.Retry), take?, catchToTarget(state.Catch), dropOrFail(OnError)))`. Tokens carry `{ id, value, enteredAt }` internally for tracing; `trace` reports `{ state, kind: 'in' | 'out' | 'drop' | 'error', tokenId, value, at }` for every token entering or leaving a state and is the hook for the live marble view (§13).

Known pitfalls:

- `switch`/`exhaust` on a state inside a cycle can drop the loop's own feedback token. Apply them on the Task that wraps the loop as a sub-machine.
- Promise resources cannot be cancelled: `switch` ignores their result but the work still runs. Use Observables (`fromFetch`, `defer`) for real cancellation.
- `forkJoin` over a branch that completes without emitting emits nothing: the token vanishes silently. `combineLatest` and `zip` have the same trait.
- `forkJoin` and `combineLatest` use each branch's last/latest value, so a multi-shot branch loses its earlier emissions; a branch that never completes blocks `forkJoin` forever. Use `Take` inside the branch, or `Join: "merge"`.
- Unbounded `merge` on an HTTP resource is unbounded parallelism. Set `MaxConcurrency` or use `concat`.

Why this model over the alternatives: a pure "compile the graph to one `pipe()`" model reads beautifully for linear chains but needs dominator analysis for Choice rejoins and loop detection for cycles; a trampolined `expand` interpreter handles cycles and rejoins but has no per-state input stream, so `Debounce`/`Throttle` cannot be expressed. The node model supports every policy with no analysis, and each node's pipe is still printable per state, which is exactly the pipe view in §13.

## 10. Prior art

- **ASL**: the topology and the `Retry`/`Catch`/`TimeoutSeconds` policy style, which RSL extends rather than replaces.
- **XState**: statecharts as JS config. Models *control* state of a component; RSL models *dataflow* through steps. XState v5's `fromObservable` actors are the closest overlap.
- **Serverless Workflow / Temporal**: workflow DSLs with one-shot executions, same gap as ASL.
- **Flow-based programming / Node-RED**: nodes with inboxes, which is the runtime model here.

## 11. Open questions

1. `Assign` / variables: what is a variable's scope when many tokens are alive? (Recommendation: per-token context object, copied along the lineage, forked into branches. Defer to v1.)
2. JSONata via the `jsonata` package for JSON-only documents? (`Condition` already reserves the `{% %}` form; add the evaluator when a no-code use case appears.)
3. A fifth shaping policy `Buffer: { Count?, TimeMs? }` (`bufferCount`/`bufferTime`) for batching? (Likely yes in v1; it changes the token type to an array.)
4. Machine-level `TimeoutSeconds` per token: tokens fan out (multi-shot Task, Map `stream`), so whose clock, and how expiry cancels inner work, need a definition. (Defer; per-state `TimeoutSeconds` covers v0.)
5. `Throttle` trailing edge (`throttleTime` config) and a total-duration Task timeout for multi-shot resources. (v1, both one field.)
6. Per-edge vs per-state shaping. (Per-state chosen. Revisit only if a state with several predecessors needs different shaping per edge.)

## 12. Implementation order

1. **Core** (done except Task, see `src/rsl/compile.ts`): Task, Pass, Choice, Succeed, Fail; `Next`/`End`; registry; shaping; `Concurrency`/`MaxConcurrency`/`Take`; `TimeoutSeconds`/`Retry`/`Catch`/`OnError`; JSONPath subset; alive counter and completion. First tests: the map + filter and live-search examples, with marble tests via vitest + RxJS `TestScheduler`.
2. **Wait + cycles**: `queueScheduler` trampolining, the feedback-token pitfall. Test: the polling example.
3. **Parallel + `Join`, Map + `Collect`**. Test: the profile example with `forkJoin` and `combineLatest`.
4. **Live marbles**: wire the `trace` hook to a per-state marble view. `toMermaid` and `toPipeView` already exist.

## 13. Visualization

The document is data, so it can be drawn without being run. Three levels:

1. **Topology graph** (`src/rsl/diagram.ts`): `toMermaid(machine)` returns Mermaid `flowchart` text. Nodes are shaped by Type: Task rectangle, Choice diamond, Wait hexagon, Pass rounded, Parallel/Map subroutine box, Succeed/Fail double circle. `Next` edges are plain; Choice rules are labelled edges (`$.job.status == "done"`, `default`); `Catch` entries are dashed edges labelled with their `ErrorEquals`. Policies form a third line in the node label (`filter: $ > 6`, `debounce 300 · distinctUntilChanged · switchMap · timeout 5s · retry ×2 on States.Timeout`). `Parallel` and `Map` render as one subgraph per branch / item processor between the state's node and a join node whose label carries the policy (`join: forkJoin`, `collect: array`). Node ids are path-prefixed (`m_LoadProfile_b0_User`) so nested machines cannot collide; labels show the real state name. Cycles are ordinary back edges. The whole machine sits between an `in` and an `out` node, because a machine is an operator.
2. **Pipe view** (`src/rsl/pipeview.ts`): `toPipeView(machine)` returns one line per state with the RxJS the state stands for, e.g. `Search: debounceTime(300) → distinctUntilChanged() → switchMap(searchApi) → timeout({ first: 5000 }) → retry(2 on States.Timeout) → catchError(→ Fallback) → output`. The diagram says where values go; the pipe view says which operators they pass through.
3. **Live marbles** (future, needs the runtime): the `trace` hook from §9 feeds a UI that draws one marble row per state as the machine runs. RxJS `TestScheduler` makes the same output deterministic for docs.

Consequences for authors: a function renders only as `fn`, so use registry names when a diagram matters, and prefer structured data tests over `Condition` for readable edge labels.

## 14. Validation

Two layers, both independent of any registry:

1. **Shape**: `rsl.schema.json` (JSON Schema 2020-12) describes the JSON form of a document: the fields each `Type` accepts and their types, exactly one of `Next` / `End: true`, exactly one comparison per data test, exactly one Wait timing field, the JSONPath subset as a pattern. Point an editor at it with `"$schema": "./rsl.schema.json"` in a JSON document or `# yaml-language-server: $schema=./rsl.schema.json` in YAML. Functions and inline machines authored in TypeScript are outside its scope; `src/rsl/types.ts` covers those.
2. **Graph**: `validate(machine)` (`src/rsl/validate.ts`) returns every `{ path, message }` issue it finds, with paths like `States.IsDone.Choices[0].Next`; `assertValid` throws them as one `RslError`; `compile` calls it before resolving references. Rules: `StartAt` names a state; every `Next`, Choice rule, `Default` and Catcher target exists in the same machine; every state is reachable from `StartAt` (Choice and Catch edges count); Pass, Task, Wait, Parallel and Map have exactly one of `Next` / `End: true`, Choice, Succeed and Fail have neither; `Choices` is non-empty; `States.ALL` is the last Retrier/Catcher and alone in its `ErrorEquals`; a Wait has exactly one timing field; every path field parses; `QueryLanguage` is `"JSONPath"`. Branches, item processors and nested-machine resources are validated recursively with prefixed paths (`States.LoadProfile.Branches[0].States.User.Next`).

Registry resolution (missing names, reserved JSONata) stays in `compile`, because it needs the registry.
