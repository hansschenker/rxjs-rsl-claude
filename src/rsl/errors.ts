/** A document or registry problem found at compile time. */
export class RslError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RslError';
  }
}

/**
 * An ASL-style runtime error. `name` is the error name that `ErrorEquals`
 * matches against (`States.NoChoiceMatched`, a Fail state's `Error`);
 * `message` is its cause.
 */
export class StateError extends Error {
  constructor(name: string, cause?: string) {
    super(cause ?? name);
    this.name = name;
  }
}

/** The name `ErrorEquals` sees (spec §6): RxJS's `TimeoutError` is `States.Timeout`, any other error its `name`. */
export function aslErrorName(error: unknown): string {
  if (error instanceof Error) return error.name === 'TimeoutError' ? 'States.Timeout' : error.name;
  return String(error);
}

/** Does a Retrier's or Catcher's `ErrorEquals` match the error? `States.ALL` matches everything. */
export function matchesError(names: readonly string[], error: unknown): boolean {
  if (names.includes('States.ALL') || names.includes(aslErrorName(error))) return true;
  return error instanceof Error && names.includes(error.name);
}

/** ASL's error output, the token a Catcher routes: `{ Error, Cause }`. */
export function errorOutput(error: unknown): { Error: string; Cause: string } {
  return { Error: aslErrorName(error), Cause: error instanceof Error ? error.message : String(error) };
}
