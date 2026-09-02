# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

An early-stage project to design **RSL (Reactive States Language)**: a declarative workflow language that takes the *topology* of AWS Step Functions' Amazon States Language (ASL) and pairs it with *RxJS execution policies*, describing how values move through a reactive workflow over time.

- `docs/plan.md` — the one-paragraph statement of intent.
- `docs/asl-syntax-flows.txt` — the ASL reference this builds on: state types (Task, Choice, Parallel, Map, Pass, Wait, Succeed, Fail), top-level fields (`StartAt`, `States`, `QueryLanguage`, `TimeoutSeconds`), common state fields (`Next`, `End`, `Assign`, `Output`, `InputPath`, `OutputPath`), and JSONata `{% ... %}` expressions.

Current state: everything under `src/` is still the untouched Vite `vanilla-ts` template (welcome page + click counter). `rxjs` is installed but not imported anywhere yet. New RSL work should replace the template code rather than extend it.

This repo is **not** one of the `rxjs-ds` / `rxjs-vitepress-ds` projects described in the parent-directory `CLAUDE.md`; the "keep both projects in sync" rule there does not apply here. Its general conventions (TypeScript strict, Prettier defaults, npm only, Conventional Commits, never commit or push unless asked) do apply.

## Commands

- `npm run dev` — Vite dev server with HMR.
- `npm run build` — runs `tsc` (type-check only, `noEmit`) and then `vite build`. Any type error fails the build.
- `npm run preview` — serve the production build from `dist/`.
- `npx tsc` — type-check without building.
- **Tests:** `vitest` is installed but there is no `test` script and no config yet.
  - All tests: `npx vitest run`
  - One file: `npx vitest run src/foo.test.ts`
  - One test by name: `npx vitest run -t "test name"`
  - Add `"test": "vitest"` to `package.json` scripts when the first test is written.
- `vitepress` is installed too, but there is no `.vitepress/` directory or docs script yet.

There is no linter or formatter configured; the TypeScript compiler flags are the only automated checks.

## Tooling constraints

- Vite runs entirely on defaults — there is no `vite.config.*`. Entry is `index.html` → `/src/main.ts`; `public/` is served at the site root (`/favicon.svg`, `/icons.svg`). Assets in `src/assets/` are imported as URLs (typed via `vite/client`).
- `tsconfig.json` is the only build config. Flags that shape how code must be written:
  - `verbatimModuleSyntax` — use `import type` for type-only imports.
  - `allowImportingTsExtensions` — local imports use explicit `.ts` extensions (`import { x } from './counter.ts'`).
  - `erasableSyntaxOnly` — no `enum`, no runtime `namespace`, no constructor parameter properties; use `as const` objects and plain classes instead.
  - `noUnusedLocals` / `noUnusedParameters` — unused symbols are errors, not warnings.
  - `moduleResolution: "bundler"`, target ES2023, `lib` includes DOM.
- Plain ESM (`"type": "module"`), no UI framework, real DOM APIs only.
