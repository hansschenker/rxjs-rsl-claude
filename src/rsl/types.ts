import type { ObservableInput } from 'rxjs';

/**
 * RSL (Reactive States Language) document schema, v0 draft.
 *
 * RSL = ASL topology + RxJS execution policies. Every ASL state type and
 * transition field keeps its meaning; RSL only adds fields ("policies").
 * See docs/rsl-spec.md for the semantics behind each field.
 */

/** Flattening strategy for successive tokens arriving at an async state. */
export type Concurrency = 'merge' | 'switch' | 'concat' | 'exhaust';

/** How the outputs of Parallel branches combine into one token stream. */
export type Join = 'forkJoin' | 'combineLatest' | 'zip' | 'merge' | 'race';

/** How Map item results are emitted: one array token, or one token per item. */
export type Collect = 'array' | 'stream';

/** A registry name (JSON-portable) or the function itself (TS-authored documents). */
export type Ref<F> = string | F;

export type ResourceFn = (input: unknown) => ObservableInput<unknown>;
export type TransformFn = (input: unknown) => unknown;
export type PredicateFn = (input: unknown) => boolean;
export type KeyFn = (input: unknown) => unknown;

/** Functions that string references in a document resolve to at compile time. */
export interface Registry {
  resources?: Record<string, ResourceFn | RslMachine>;
  transforms?: Record<string, TransformFn>;
  predicates?: Record<string, PredicateFn>;
  keys?: Record<string, KeyFn>;
}

/** ASL Retrier, field names verbatim. Defaults: IntervalSeconds 1, MaxAttempts 3, BackoffRate 2. */
export interface Retrier {
  ErrorEquals: string[];
  IntervalSeconds?: number;
  MaxAttempts?: number;
  BackoffRate?: number;
  MaxDelaySeconds?: number;
}

/** ASL Catcher, field names verbatim. ResultPath defaults to "$". */
export interface Catcher {
  ErrorEquals: string[];
  Next: string;
  ResultPath?: string;
}

/** The v0 subset of ASL JSONPath-mode comparison operators. */
export type Comparison =
  | { StringEquals: string }
  | { StringLessThan: string }
  | { StringGreaterThan: string }
  | { NumericEquals: number }
  | { NumericLessThan: number }
  | { NumericGreaterThan: number }
  | { NumericLessThanEquals: number }
  | { NumericGreaterThanEquals: number }
  | { BooleanEquals: boolean }
  | { IsPresent: boolean }
  | { IsNull: boolean };

/** An ASL data test: a JSONPath `Variable` plus exactly one comparison. */
export type DataTest = { Variable: string } & Comparison;

/**
 * A boolean test over the token value. `Condition` is ASL's own field name:
 * a `{% ... %}` string is JSONata (reserved, rejected in v0), any other string
 * is a registry predicate name, a function when authored in TS.
 */
export type Test =
  | DataTest
  | { Condition: Ref<PredicateFn> }
  | { And: Test[] }
  | { Or: Test[] }
  | { Not: Test };

export type ChoiceRule = Test & { Next: string };

/** Exactly one of `Next` or `End: true`, as in ASL. */
export type Transition = { Next: string; End?: undefined } | { End: true; Next?: undefined };

/** Input-shaping policies: which of the tokens arriving at a state get to run. Applied in this order. */
export interface Shaping {
  /** `filter(predicate)` on the state's inbox. */
  Filter?: Ref<PredicateFn> | Test;
  /** `debounceTime(ms)` on the state's inbox. */
  Debounce?: number;
  /** `throttleTime(ms)`, leading edge, on the state's inbox. */
  Throttle?: number;
  /** `distinctUntilChanged` on the token value; a `$`-path or a key selects what to compare. */
  DistinctUntilChanged?: true | string | KeyFn;
}

export interface Common extends Shaping {
  Comment?: string;
  InputPath?: string;
  OutputPath?: string;
}

export type PassState = Common &
  Transition & {
    Type: 'Pass';
    Result?: unknown;
    ResultPath?: string;
    /** `(input) => output`; replaces ASL `Parameters` templating in v0. */
    Transform?: Ref<TransformFn>;
  };

export type TaskState = Common &
  Transition & {
    Type: 'Task';
    Resource: Ref<ResourceFn> | RslMachine;
    ResultPath?: string;
    Concurrency?: Concurrency;
    /** Only meaningful with `merge`; `0` means unlimited. */
    MaxConcurrency?: number;
    /** `take(n)` on the resource output; `1` makes a multi-shot resource one-shot. */
    Take?: number;
    /** `timeout({ first: seconds * 1000 })`: time until the resource's first emission. */
    TimeoutSeconds?: number;
    Retry?: Retrier[];
    Catch?: Catcher[];
  };

/** ASL Wait timing fields, mutually exclusive. */
export type WaitTiming =
  | { Seconds: number; Timestamp?: undefined; SecondsPath?: undefined; TimestampPath?: undefined }
  | { Timestamp: string; Seconds?: undefined; SecondsPath?: undefined; TimestampPath?: undefined }
  | { SecondsPath: string; Seconds?: undefined; Timestamp?: undefined; TimestampPath?: undefined }
  | { TimestampPath: string; Seconds?: undefined; Timestamp?: undefined; SecondsPath?: undefined };

export type WaitState = Common & Transition & WaitTiming & { Type: 'Wait' };

export type ChoiceState = Common & {
  Type: 'Choice';
  Choices: ChoiceRule[];
  Default?: string;
};

export type ParallelState = Common &
  Transition & {
    Type: 'Parallel';
    Branches: RslMachine[];
    Join?: Join;
    Concurrency?: Concurrency;
    ResultPath?: string;
    Retry?: Retrier[];
    Catch?: Catcher[];
  };

export type MapState = Common &
  Transition & {
    Type: 'Map';
    ItemProcessor: RslMachine;
    /** Defaults to `$`; selects any `ObservableInput` (array, iterable, Observable). */
    ItemsPath?: string;
    /** Inner concurrency across items; `0` means unlimited. */
    MaxConcurrency?: number;
    Collect?: Collect;
    /** Outer concurrency across successive input tokens. */
    Concurrency?: Concurrency;
    ResultPath?: string;
    Retry?: Retrier[];
    Catch?: Catcher[];
  };

export type SucceedState = Common & { Type: 'Succeed' };

export type FailState = Common & { Type: 'Fail'; Error?: string; Cause?: string };

export type RslState =
  | PassState
  | TaskState
  | WaitState
  | ChoiceState
  | ParallelState
  | MapState
  | SucceedState
  | FailState;

export interface RslMachine {
  Comment?: string;
  Version?: string;
  /** Reserved. Only "JSONPath" is accepted in v0. */
  QueryLanguage?: 'JSONPath';
  StartAt: string;
  States: Record<string, RslState>;
  /** Uncaught errors and Fail states: error the output stream, or end that token only. */
  OnError?: 'fail' | 'drop';
}
