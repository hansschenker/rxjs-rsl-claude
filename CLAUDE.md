# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**RSL (Reactive States Language)**: a declarative workflow language that takes the *topology* of AWS Step Functions' Amazon States Language (ASL) and pairs it with *RxJS execution policies*, describing how values move through a reactive workflow over time.

- `docs/rsl-spec.md` — the language definition (v0 draft). Read this before touching anything under `src/rsl/`.
- `docs/plan.md` — the one-paragraph statement of intent.
- `docs/asl-syntax-flows.txt` — the ASL reference the language builds on.

Current state:

- `src/rsl/types.ts` — the document schema. Arrays in it are `readonly` so literal documents (readonly tuples under a `const` type parameter) stay assignable; registry function types take `never` by default so a typed function (`(order: Order) => …`) fits any bucket, and the runtime casts once at the boundary (`RuntimeFn` in `evaluate.ts`).
- `src/rsl/registry.ts` — the typed registry (spec §6): `defineMachine` keeps a document's literal types; `ResourceNames<M>` etc. read the referenced names off the type (nested machines included); `RegistryFor<M>` makes a bucket required and name-checked when it has literal names; `CompileArgs<M>` makes the registry argument itself required then. Every name walk short-circuits to `string` on a widened type (`StartAt: string`), and `TestNames` has a `Test extends T` guard: without those, `RslMachine` and `Test` (which refer to themselves) send `tsc` into "type instantiation is excessively deep" on any call with a literal document. `src/rsl/typed.test.ts` holds the `expectTypeOf` / `@ts-expect-error` assertions; keep type-only calls inside a never-invoked function there.
- `src/rsl/examples.ts` — the spec's examples, written with `defineMachine` (not an `RslMachine` annotation, which would widen away the names; not `satisfies`, which normalises array literals of differing shapes into phantom `?: undefined` keys). `checkoutResources` / `checkoutRegistry` show a typed registry.
- `src/rsl/document.ts` — `parseDocument(text)`: JSON text → `assertValid` → `RslMachine`. The schema is not applied there.
- `src/cli/rsl.ts` — the `rsl` command line (spec §15): `main(argv, io)` with injected output, so `src/cli/rsl.test.ts` drives it against a temp directory; `src/cli/bin.ts` is the shebang wrapper. Node APIs live only here, never under `src/rsl/`. The schema check imports `ajv` dynamically and skips with a note when it is absent; `rsl.schema.json` is found by walking up from the module, which works from `src/cli/` and from `dist/lib/cli/`.
- `rsl.schema.json` (repo root) — JSON Schema 2020-12 for the JSON form of a document, mirroring `types.ts`; `src/rsl/schema.test.ts` compiles it with Ajv in strict mode and checks it against the examples, so keep the two in step. `src/rsl/validate.ts` — the graph rules a schema cannot express (spec §14): `validate` returns `{ path, message }` issues, `assertValid` throws them as one `RslError`, and `compile` calls it before touching the registry.
- `src/rsl/diagram.ts` (`toMermaid`) and `src/rsl/pipeview.ts` (`toPipeView`) render a document as a Mermaid flowchart and as a per-state RxJS operator list. Both are pure string builders; `src/rsl/labels.ts` holds their shared helpers.
- `src/main.ts` is a demo page that renders every example both ways. It is the only place that imports `mermaid`; nothing under `src/rsl/` may import it.
- `src/rsl/compile.ts` is the runtime (spec §9): one Subject per state, `observeOn(queueScheduler)` on every inbox, errors resolved per token, completion by an alive-token counter. Two phases: `planMachine` (once per `compile`: validation, registry resolution, nested plans) and `runMachine` (once per subscription: counters, inboxes, reporting; a nested machine is run through it per token). Implemented: Pass, Task, Wait, Choice, Succeed, Fail, all four shaping policies, `OnError`. Parallel and Map throw `RslError` at compile time until their slices land. Helpers: `paths.ts` (JSONPath subset), `evaluate.ts` (data tests, registry resolution), `errors.ts` (error classes, `aslErrorName` / `matchesError` / `errorOutput`).
- Task (spec §3): `defer(() => from(resource(input)))` → `timeout({ first })` → retry with one counter per Retrier (event `retry` at the moment of the error, delay `IntervalSeconds · BackoffRate^(n-1)` capped by `MaxDelaySeconds`) → `take` → outputs; an error no Retrier absorbs goes to the first matching Catcher (event `catch`, `{ Error, Cause }` at its `ResultPath`, default `$`) or to `OnError`. `Concurrency` is `mergeMap(…, MaxConcurrency)` / `concatMap` / `switchMap` / `exhaustMap` (a pre-filter reports the ignored token as `drop` with policy `Concurrency`). A Resource that is a machine runs through `runMachine` per token with `run` prefixed `States.<name>.Resource#<tokenId>` and `OnError` inherited unless set. Alive accounting: a source value is one alive token; each Task output is a new one; a Task's projection ends its input token exactly once, in `finalize` (or through `fail`, which sets `ended`), and reports `cancel` there when it did not settle (`switch`, or `unsubscribe` when the run was torn down: a first finalizer on the run's Subscription sets the flag). Completion depends on this being exactly once.
- Wait is planned as a Task whose resource is `timer(due(input))` (merge, no Retry / Catch / Take), so it reuses all of the above, including `cancel` at teardown. `waitDue` turns the four timing fields into a per-token ms function: a constant `Timestamp` that does not parse is a compile-time `RslError`; a `SecondsPath` / `TimestampPath` value that is not a duration or a time is a per-token `StateError('States.Runtime')` for `OnError`; a past time waits 0 ms. `asyncScheduler.now()` is the clock, so `Timestamp` tests use `new Date(frame).toISOString()` under `TestScheduler`. The polling example has a registry (`pollingRegistry`, a job is done on its third poll and then resets) and runs in the demo, the golden traces and `compile.test.ts`, which also tests the §8 pattern of wrapping the loop in an `exhaust` Task.
- `src/rsl/trace.ts` — the `TraceEvent` union (`in`, `out`, `drop`, `error`, `cancel`, `retry`, `catch`; spec §9 has the table), `Token`, the `OUTPUT` sentinel and `traceLine`. No runtime imports, so renderers (a future trace overlay in `diagram.ts`) can depend on it without depending on `compile`. Every kind is emitted by the runtime.
- Runtime tests are marble tests with RxJS `TestScheduler` in `src/rsl/compile.test.ts`. Shaping operators are hand-written (not the stock `debounceTime` etc.) so that every suppressed token can decrement the alive counter; keep it that way.
- Golden traces: `src/rsl/trace.test.ts` runs every example that has a `run` config under virtual time and compares the events with `src/rsl/traces/<slug>.trace.json` (`toMatchFileSnapshot`). Adding `run` to an example adds a golden file on the next test run; `npx vitest run -u` accepts an intentional change to the trace shape or the runtime's reporting. Review the diff before accepting. An example whose states the runtime rejects as "not implemented" is skipped (visibly) rather than failed, and the demo page shows it as "not run yet".
- `src/rsl/task.test.ts` — the Task slice's acceptance tests, written before it landed: the four `Concurrency` marble tests and the checkout scenarios (happy path, ValidationError → Reject, timeout retries with backoff, retries exhausted → Reject, concat ordering). `src/rsl/compile.test.ts` has the rest of Task: paths, multi-shot and `Take`, `MaxConcurrency`, cancel on unsubscribe, `OnError`, Catch, per-Retrier counters and `MaxDelaySeconds`, nested machines. The same pattern (tests gated on a probe compile, `describe.runIf`) is the way to write the Parallel and Map slices' tests ahead of them.

This repo is **not** one of the `rxjs-ds` / `rxjs-vitepress-ds` projects described in the parent-directory `CLAUDE.md`; the "keep both projects in sync" rule there does not apply here. Its general conventions (TypeScript strict, Prettier defaults, npm only, Conventional Commits, never commit or push unless asked) do apply.

## Commands

- `npm run dev` — Vite dev server with HMR.
- `npm run rsl -- <command> <doc.json> …` — the CLI from source (Node 24 strips the types itself). The built `bin` is `dist/lib/cli/bin.js`.
- `npm run build` — the done-criteria gate: `typecheck` (`tsc`, `noEmit`), `build:lib` (`tsc -p tsconfig.lib.json` → `dist/lib/rsl` and `dist/lib/cli`, ESM + declarations), `build:site` (`vite build --outDir dist/site`), then `smoke` (imports `dist/lib/rsl/index.js` in Node and checks `compile` is there). Any type error fails the build.
- `npm run preview` — serve the demo site from `dist/site`.
- `npm run typecheck` — type-check without building.
- `npm test` — all tests once (`vitest run`). `npx vitest` for watch mode.
  - One file: `npx vitest run src/rsl/rsl.test.ts`
  - One test by name: `npx vitest run -t "test name"`
- CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run build`, `npm test` on Node 24 for pushes to `main` and pull requests. Under `CI=true` vitest fails on a missing golden trace instead of writing it, so commit new golden files with the change that creates them.

There is no linter or formatter configured; the TypeScript compiler flags are the only automated checks.

## Packaging

- `package.json` is publishable in shape but `private: true`; flipping that (and choosing the final name) is the only step to publish. `rxjs` is a peer dependency; `mermaid` is a devDependency used only by the demo page.
- Entries: `.` → `dist/lib/rsl/index.js` (the barrel `src/rsl/index.ts`: compile, validate, parseDocument, defineMachine and the registry types, renderers, trace helpers, errors, paths, all types), `./examples` → `dist/lib/rsl/examples.js`, `./schema` → `rsl.schema.json`; `bin` `rsl` → `dist/lib/cli/bin.js`. `src/rsl/index.test.ts` pins what the barrel exports; add new public API there.
- `files` ships `dist/lib`, the schema and the spec. `sideEffects: false`.
- The emitted `.d.ts` files keep the `.ts` import specifiers (`rewriteRelativeImportExtensions` rewrites JavaScript only). That is fine: a packed tarball installed into a scratch consumer type-checked under both `nodenext` and `bundler` resolution, with and without `skipLibCheck`, and ran in plain Node. Do not add a post-processing step for it.

## Tooling constraints

- Vite runs entirely on defaults — there is no `vite.config.*`. Entry is `index.html` → `/src/main.ts`; `public/` is served at the site root (`/favicon.svg`). The site's output directory is given on the command line (`dist/site`).
- Two tsconfigs. `tsconfig.json` is the type-check / test / demo config (`noEmit`, types `vite/client` + `node`). `tsconfig.lib.json` extends it for the library and CLI emit: `src/rsl` and `src/cli`, tests excluded, `rootDir` `src`, `outDir` `dist/lib`, `lib` without DOM, types `node`, and `rewriteRelativeImportExtensions` so the `.ts` extensions in source imports become `.js` in the output. Nothing under `src/rsl/` (tests aside) may use DOM globals or Node APIs, or import from outside `src/rsl/`; Node APIs belong in `src/cli/`. Flags that shape how code must be written:
  - `verbatimModuleSyntax` — use `import type` for type-only imports.
  - `allowImportingTsExtensions` — local imports use explicit `.ts` extensions (`import { x } from './types.ts'`).
  - `erasableSyntaxOnly` — no `enum`, no runtime `namespace`, no constructor parameter properties; use string-literal unions, `as const` objects, and plain classes instead.
  - `noUnusedLocals` / `noUnusedParameters` — unused symbols (including unused `import type`) are errors, not warnings.
  - `moduleResolution: "bundler"`, target ES2023, `lib` includes DOM.
- Plain ESM (`"type": "module"`), no UI framework, real DOM APIs only.
- Adding a policy to the language means touching, in order: `docs/rsl-spec.md` (§4/§5 tables), `src/rsl/types.ts`, `rsl.schema.json`, `src/rsl/validate.ts` (only if the policy has a structural rule), `src/rsl/registry.ts` (only if the policy holds a registry name), `src/rsl/pipeview.ts`, `src/rsl/diagram.ts`, `src/rsl/compile.ts`, and tests in `src/rsl/rsl.test.ts`, `src/rsl/schema.test.ts`, `src/rsl/validate.test.ts`, `src/rsl/typed.test.ts` and `src/rsl/compile.test.ts`.
