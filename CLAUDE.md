# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**RSL (Reactive States Language)**: a declarative workflow language that takes the *topology* of AWS Step Functions' Amazon States Language (ASL) and pairs it with *RxJS execution policies*, describing how values move through a reactive workflow over time.

- `docs/rsl-spec.md` — the language definition (v0 draft). Read this before touching anything under `src/rsl/`.
- `docs/plan.md` — the one-paragraph statement of intent.
- `docs/asl-syntax-flows.txt` — the ASL reference the language builds on.

Current state:

- `src/rsl/types.ts` — the document schema. `src/rsl/examples.ts` — the spec's examples, typed as `RslMachine` (an explicit annotation, not `satisfies`: array literals of differing branch shapes get phantom `?: undefined` keys under `satisfies` and fail the `States` index signature).
- `src/rsl/diagram.ts` (`toMermaid`) and `src/rsl/pipeview.ts` (`toPipeView`) render a document as a Mermaid flowchart and as a per-state RxJS operator list. Both are pure string builders; `src/rsl/labels.ts` holds their shared helpers.
- `src/main.ts` is a demo page that renders every example both ways. It is the only place that imports `mermaid`; nothing under `src/rsl/` may import it.
- The runtime (`compile`, spec §9) is **not implemented yet**. `rxjs` is installed but only its types are used so far.

This repo is **not** one of the `rxjs-ds` / `rxjs-vitepress-ds` projects described in the parent-directory `CLAUDE.md`; the "keep both projects in sync" rule there does not apply here. Its general conventions (TypeScript strict, Prettier defaults, npm only, Conventional Commits, never commit or push unless asked) do apply.

## Commands

- `npm run dev` — Vite dev server with HMR.
- `npm run build` — runs `tsc` (type-check only, `noEmit`) and then `vite build`. Any type error fails the build.
- `npm run preview` — serve the production build from `dist/`.
- `npx tsc` — type-check without building.
- `npm test` — all tests once (`vitest run`). `npx vitest` for watch mode.
  - One file: `npx vitest run src/rsl/rsl.test.ts`
  - One test by name: `npx vitest run -t "test name"`
- `vitepress` is installed, but there is no `.vitepress/` directory or docs script yet.

There is no linter or formatter configured; the TypeScript compiler flags are the only automated checks.

## Tooling constraints

- Vite runs entirely on defaults — there is no `vite.config.*`. Entry is `index.html` → `/src/main.ts`; `public/` is served at the site root (`/favicon.svg`).
- `tsconfig.json` is the only build config. Flags that shape how code must be written:
  - `verbatimModuleSyntax` — use `import type` for type-only imports.
  - `allowImportingTsExtensions` — local imports use explicit `.ts` extensions (`import { x } from './types.ts'`).
  - `erasableSyntaxOnly` — no `enum`, no runtime `namespace`, no constructor parameter properties; use string-literal unions, `as const` objects, and plain classes instead.
  - `noUnusedLocals` / `noUnusedParameters` — unused symbols (including unused `import type`) are errors, not warnings.
  - `moduleResolution: "bundler"`, target ES2023, `lib` includes DOM.
- Plain ESM (`"type": "module"`), no UI framework, real DOM APIs only.
- Adding a policy to the language means touching, in order: `docs/rsl-spec.md` (§4/§5 tables), `src/rsl/types.ts`, `src/rsl/pipeview.ts`, `src/rsl/diagram.ts`, and a test in `src/rsl/rsl.test.ts`.
