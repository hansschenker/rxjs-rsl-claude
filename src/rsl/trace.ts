import type { Shaping } from './types.ts';

/**
 * Trace events (spec §9): everything that happens to a token at a state,
 * reported through the `trace` option of `compile`. This is the hook for the
 * live marble view and the trace overlay (§13); the golden traces under
 * `src/rsl/traces/` pin the shape. Pure data and formatting, no runtime
 * imports, so renderers can depend on it without depending on `compile`.
 */

/** A value travelling through a machine. `id` and `enteredAt` survive transformations. */
export interface Token {
  readonly id: number;
  readonly value: unknown;
  readonly enteredAt: number;
}

/** The `target` of an `out` event whose token leaves the machine through End / Succeed. */
export const OUTPUT = '$output';

/** What suppressed a token: an input-shaping policy, or `Concurrency` when `exhaust` ignores a newcomer. */
export type DropPolicy = keyof Shaping | 'Concurrency';

/** Why in-flight work was abandoned: the machine was torn down, or `switch` moved on to a newer token. */
export type CancelReason = 'unsubscribe' | 'switch';

/** Fields every trace event carries. */
export interface TraceBase {
  /**
   * Which run of which machine the state belongs to: `''` in the root machine.
   * A Parallel, Map or Task that runs a nested machine prefixes it with the
   * nested machine's location and its own token id (`States.LoadProfile.Branches[0]#3`);
   * a nested `compile` never sets it itself.
   */
  readonly run: string;
  readonly state: string;
  readonly tokenId: number;
  /** The token's value at the state: its input, or for `out` the output. */
  readonly value: unknown;
  /** Scheduler time; virtual frames under `TestScheduler`. */
  readonly at: number;
}

export type TraceEvent = TraceBase &
  (
    /** The token entered the state's inbox. */
    | { readonly kind: 'in' }
    /** The token left the state for `target`: a state name, or `OUTPUT` when leaving the machine. */
    | { readonly kind: 'out'; readonly target: string }
    /** A policy suppressed the token; it ends here. */
    | { readonly kind: 'drop'; readonly policy: DropPolicy }
    /** The token's error reached the machine's `OnError` (after Retry and Catch): `drop` ends the token, `fail` errors the stream. */
    | { readonly kind: 'error'; readonly error: unknown; readonly onError: 'fail' | 'drop' }
    /** In-flight work for the token was abandoned. */
    | { readonly kind: 'cancel'; readonly reason: CancelReason }
    /** A Retrier caught the error and scheduled another run of the resource, reported at the moment of the error; `attempt` is 1 for the first retry. */
    | { readonly kind: 'retry'; readonly attempt: number; readonly error: unknown }
    /** A Catcher routed the error token to `target`; takes the place of `out` for that token. */
    | { readonly kind: 'catch'; readonly error: unknown; readonly target: string }
  );

export type TraceKind = TraceEvent['kind'];

/** One human-readable line per event, e.g. `out    Double       #0 2 → Emit`. */
export function traceLine(event: TraceEvent): string {
  const where = event.run === '' ? event.state : `${event.run} ${event.state}`;
  const head = `${event.kind.padEnd(6)} ${where.padEnd(12)} #${event.tokenId} ${JSON.stringify(event.value) ?? 'undefined'}`;
  switch (event.kind) {
    case 'in':
      return head;
    case 'out':
      return `${head} → ${event.target}`;
    case 'drop':
      return `${head} (${event.policy})`;
    case 'error':
      return `${head} ${errorName(event.error)} → ${event.onError}`;
    case 'cancel':
      return `${head} (${event.reason})`;
    case 'retry':
      return `${head} retry ${event.attempt}: ${errorName(event.error)}`;
    case 'catch':
      return `${head} ${errorName(event.error)} → ${event.target}`;
  }
}

/** The name `ErrorEquals` would match, or the value itself for non-Error throws. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String(error);
}
