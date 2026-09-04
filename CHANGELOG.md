# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). Nothing has been published yet:
everything below is unreleased, and the first publish becomes 0.1.0.

## [Unreleased]

### Language

- RSL v0 draft specification (`docs/rsl-spec.md`): every ASL state type and
  transition field kept, plus a fixed vocabulary of policies for the time
  dimension. Input shaping (`Filter`, `Debounce`, `Throttle`,
  `DistinctUntilChanged`), execution (`Concurrency`, `MaxConcurrency`,
  `TimeoutSeconds`, `Retry`, `Catch`, `Take`), combination (`Join`,
  `Collect`) and the machine-level `OnError`.
- TypeScript schema (`src/rsl/types.ts`) and JSON Schema 2020-12
  (`rsl.schema.json`, also exported as `rxjs-rsl-claude/schema`) for the JSON
  form of a document.
- Structural validation (`validate`, `assertValid`): targets exist,
  reachability from `StartAt`, exactly one of `Next` / `End`, `States.ALL`
  placement, Wait timing fields, path syntax, nested machines.
- Typed registries: `defineMachine` keeps a document's literal types, and
  `RegistryFor<typeof doc>` / `compile(doc, registry)` require every
  referenced resource, transform, predicate and key, in the right bucket,
  nested machines included. Registry functions declare their input type.
- `parseDocument(text)`: JSON text in, a structurally valid document out.

### Runtime

- `compile(machine, registry, options)` turns a document into an RxJS
  operator: one Subject per state, trampolined delivery so cycles iterate,
  errors resolved per token, completion by an alive-token counter.
  Implemented: Pass, Task (resources, `Concurrency` with `MaxConcurrency`,
  `TimeoutSeconds`, `Retry` with one counter per Retrier and `MaxDelaySeconds`,
  `Catch` with `ResultPath`, `Take`, a machine as Resource with a prefixed
  trace and inherited `OnError`), Choice, Succeed, Fail, the four shaping
  policies, `OnError`, the JSONPath subset. Wait, Parallel and Map are
  rejected at compile time.
- Trace events (`in`, `out`, `drop`, `error`, `cancel`, `retry`, `catch`)
  with a `run` field reserved for nested machines, `traceLine` formatting,
  and golden traces under `src/rsl/traces/`.

### Rendering

- `toMermaid`: the topology as a Mermaid flowchart, policies as node badges,
  Catch as dashed edges, branches and item processors as subgraphs.
- `toPipeView`: one line per state with the RxJS operators it stands for.

### Examples

- map + filter, live search, polling loop, parallel profile, and checkout
  (`rxjs-rsl-claude/examples`), all type-checked, schema-checked and
  rendered by the demo page.

### Tooling

- `rsl` command line (`bin`): `validate` (graph rules, then the JSON Schema
  when `ajv` is installed), `pipe`, `viz` (Mermaid text, `.mmd` file or a
  self-contained page), `run` (a registry module and a JSON array of inputs
  in, one JSON line per output, optional trace file or live trace lines).
- Library build to `dist/lib` (ESM + declarations), demo site build to
  `dist/site`, Vitest suite with marble tests, Ajv schema tests and golden
  traces, GitHub Actions CI running the build and the tests.
