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
