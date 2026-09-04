# RSL — Reactive States Language

RSL = ASL topology + RxJS execution policies: a declarative workflow language
describing how values move through a reactive workflow over time.

It takes the state-machine topology of AWS Step Functions' Amazon States
Language (`StartAt`, `Next`, `Choice`, `Parallel`, `Map`, `Retry`, `Catch`)
unchanged and adds a small, fixed vocabulary of policies for the things ASL has
no answer to: what happens when a second value arrives while the first is still
running, debouncing, cancellation, timeouts, and multi-shot results. A document
compiles to an RxJS `OperatorFunction`, so machines nest and compose like any
other operator.

The language definition is [`docs/rsl-spec.md`](./docs/rsl-spec.md). Read it
first; everything under `src/rsl/` follows it.

```json
{
  "StartAt": "Search",
  "States": {
    "Search": {
      "Type": "Task",
      "Resource": "searchApi",
      "Debounce": 300,
      "DistinctUntilChanged": true,
      "Concurrency": "switch",
      "TimeoutSeconds": 5,
      "Catch": [{ "ErrorEquals": ["States.ALL"], "Next": "Fallback" }],
      "End": true
    },
    "Fallback": { "Type": "Pass", "Result": { "results": [], "error": true }, "End": true }
  }
}
```

```
Search: debounceTime(300) → distinctUntilChanged() → switchMap(searchApi) → timeout({ first: 5000 }) → catchError(→ Fallback) → output
```

## Try it

```bash
npm install
npm run dev      # demo page: every example as a diagram, a pipe view and (where the runtime supports it) a run trace
npm test         # vitest: marble tests, schema tests, golden traces
npm run build    # type-check, library build (dist/lib), demo site build (dist/site), import smoke test
```

## Use it

The package is not published yet (`private: true`); the build produces a
consumable library under `dist/lib` with an exports map, and `rxjs` is a peer
dependency.

```ts
import { from } from 'rxjs';
import { compile, validate } from 'rxjs-rsl-claude';
import { mapFilter } from 'rxjs-rsl-claude/examples';

validate(mapFilter); // [] when the document is well-formed
from([1, 2, 3, 4, 5])
  .pipe(compile(mapFilter, { transforms: { double: (n) => (n as number) * 2 } }))
  .subscribe(console.log); // 8, 10
```

Point an editor at the schema with `"$schema": "./rsl.schema.json"` in a JSON
document (`rxjs-rsl-claude/schema` from the package).

### Typed registries

Write a document with `defineMachine` and its registry is checked at compile
time: every resource, transform, predicate and key the document names must be
there, in the right bucket, nested machines included. Registry functions
declare the input they expect.

```ts
import { compile, defineMachine } from 'rxjs-rsl-claude';
import type { RegistryFor } from 'rxjs-rsl-claude';

const doc = defineMachine({
  StartAt: 'Double',
  States: {
    Double: { Type: 'Pass', Transform: 'double', Next: 'Emit' },
    Emit: { Type: 'Succeed', Filter: { Condition: 'big' } },
  },
});

const registry = {
  transforms: { double: (n: number) => n * 2 },
  predicates: { big: (n: number) => n > 6 },
} satisfies RegistryFor<typeof doc>;

compile(doc, registry);                          // ok
compile(doc, { transforms: registry.transforms }); // error: "big" is missing from predicates
```

## Command line

`rsl` works on JSON documents (`npm run rsl -- …` from a checkout; the
package's `bin` once installed):

```bash
rsl validate checkout.json                       # graph rules, then the JSON Schema; exit 1 on any issue
rsl pipe checkout.json                           # one line per state with the RxJS it stands for
rsl viz checkout.json --out checkout.html        # the flowchart, as Mermaid text or a self-contained page
rsl run map-filter.json --registry ./registry.mjs --input values.json --trace trace.json
```

`run` pipes each element of the input array through the machine and prints one
JSON line per output value; `--trace` writes the events, `--verbose` prints
one line per event as they happen.

## Layout

| Path | Role |
|---|---|
| `docs/rsl-spec.md` | The language definition (v0 draft) |
| `rsl.schema.json` | JSON Schema 2020-12 for the JSON form of a document |
| `src/rsl/types.ts` | The TypeScript schema |
| `src/rsl/validate.ts` | Structural rules a schema cannot express |
| `src/rsl/registry.ts` | Typed registries: `defineMachine`, `RegistryFor` |
| `src/rsl/document.ts` | `parseDocument`: JSON text → valid document |
| `src/rsl/compile.ts` | The runtime: document → `OperatorFunction` |
| `src/rsl/trace.ts` | Trace events and their formatting |
| `src/rsl/diagram.ts`, `src/rsl/pipeview.ts` | Mermaid flowchart and per-state operator view |
| `src/rsl/examples.ts` | The spec's examples with their registries |
| `src/rsl/traces/` | Golden traces, one per runnable example |
| `src/cli/` | The `rsl` command line |
| `src/main.ts` | The demo page |

## Status

The runtime runs Pass, Task (resources, `Concurrency`, `TimeoutSeconds`,
`Retry`, `Catch`, `Take`, nested machines), Wait (all four timing fields),
Choice, Succeed, Fail, all four shaping policies, `OnError`, and cycles.
Parallel and Map are specified, rendered and validated but rejected by the
runtime until their slices land. See spec §12 for the order of work.

## License

MIT
