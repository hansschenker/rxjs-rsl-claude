/**
 * The package entry (`rxjs-rsl-claude`). Everything a consumer needs to
 * validate, render and run an RSL document. The spec's examples are a
 * separate entry (`rxjs-rsl-claude/examples`) so they stay out of app bundles.
 */

export { compile } from './compile.ts';
export type { CompileOptions } from './compile.ts';

export { toMermaid } from './diagram.ts';
export type { MermaidOptions } from './diagram.ts';

export { parseDocument } from './document.ts';

export { RslError, StateError } from './errors.ts';

export { getPath, parsePath, setPath } from './paths.ts';

export { stateOps, toPipeView } from './pipeview.ts';

export { defineMachine } from './registry.ts';
export type { CompileArgs, KeyNames, PredicateNames, RegistryFor, ResourceNames, TransformNames } from './registry.ts';

export { OUTPUT, errorName, traceLine, traceToJson } from './trace.ts';
export type { CancelReason, DropPolicy, Token, TraceBase, TraceEvent, TraceKind } from './trace.ts';

export type * from './types.ts';

export { assertValid, validate } from './validate.ts';
export type { Issue } from './validate.ts';
