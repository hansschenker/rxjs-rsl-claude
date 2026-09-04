import type { ObservableInput } from 'rxjs';
import { RslError } from './errors.ts';
import { getPath } from './paths.ts';
import type { DataTest, KeyFn, PredicateFn, Ref, Registry, ResourceFn, RslMachine, Test } from './types.ts';

/**
 * Registry functions declare the input they expect (`(order: Order) => …`);
 * the runtime hands them the token value, so it sees them as taking
 * `unknown`. That cast happens once, here, at the registry boundary.
 */
export type RuntimeFn<R> = (value: unknown) => R;

/**
 * Resolve a document reference at compile time: a function is returned as is,
 * a string is looked up in the given registry bucket. Missing names and
 * reserved JSONata strings fail here, not at run time.
 */
export function resolveRef<F extends (input: never) => unknown>(
  ref: Ref<F>,
  bucket: Readonly<Record<string, F>> | undefined,
  kind: string,
  where: string,
): RuntimeFn<ReturnType<F>> {
  if (typeof ref !== 'string') return ref as unknown as RuntimeFn<ReturnType<F>>;
  if (ref.startsWith('{%')) {
    throw new RslError(`${where}: JSONata expressions ({% ... %}) are reserved and not evaluated in v0`);
  }
  const fn = bucket?.[ref];
  if (fn === undefined) throw new RslError(`${where}: no ${kind} named "${ref}" in the registry`);
  return fn as unknown as RuntimeFn<ReturnType<F>>;
}

/** A Task's `Resource`: a registry name (of a function or a nested machine), an inline function, or an inline machine. */
export function resolveResource(
  ref: Ref<ResourceFn> | RslMachine,
  registry: Registry,
  where: string,
): RuntimeFn<ObservableInput<unknown>> | RslMachine {
  if (typeof ref === 'function') return ref as unknown as RuntimeFn<ObservableInput<unknown>>;
  if (typeof ref === 'object') return ref;
  if (ref.startsWith('{%')) {
    throw new RslError(`${where}: JSONata expressions ({% ... %}) are reserved and not evaluated in v0`);
  }
  const found = registry.resources?.[ref];
  if (found === undefined) throw new RslError(`${where}: no resource named "${ref}" in the registry`);
  return typeof found === 'function' ? (found as unknown as RuntimeFn<ObservableInput<unknown>>) : found;
}

/** The comparison key for `DistinctUntilChanged`: identity, a `$`-path, or a key function. */
export function resolveKey(ref: true | string | KeyFn, registry: Registry, where: string): RuntimeFn<unknown> {
  if (ref === true) return (value) => value;
  if (typeof ref === 'string' && ref.startsWith('$')) return (value) => getPath(value, ref);
  return resolveRef(ref, registry.keys, 'key', where);
}

/** Compile a Choice rule, a `Filter`, or a `Condition` into a predicate over the token value. */
export function compileTest(test: Test | Ref<PredicateFn>, registry: Registry, where: string): RuntimeFn<boolean> {
  if (typeof test === 'string' || typeof test === 'function') {
    return resolveRef(test, registry.predicates, 'predicate', where);
  }
  if ('And' in test) {
    const parts = test.And.map((part) => compileTest(part, registry, where));
    return (value) => parts.every((part) => part(value));
  }
  if ('Or' in test) {
    const parts = test.Or.map((part) => compileTest(part, registry, where));
    return (value) => parts.some((part) => part(value));
  }
  if ('Not' in test) {
    const inner = compileTest(test.Not, registry, where);
    return (value) => !inner(value);
  }
  if ('Condition' in test) return compileTest(test.Condition, registry, where);
  return compileDataTest(test);
}

function compileDataTest(test: DataTest): RuntimeFn<boolean> {
  const compare = comparison(test);
  return (value) => compare(getPath(value, test.Variable));
}

/** ASL semantics: a comparison against a value of the wrong type is false, not an error. */
function comparison(test: DataTest): (v: unknown) => boolean {
  if ('StringEquals' in test) return (v) => typeof v === 'string' && v === test.StringEquals;
  if ('StringLessThan' in test) return (v) => typeof v === 'string' && v < test.StringLessThan;
  if ('StringGreaterThan' in test) return (v) => typeof v === 'string' && v > test.StringGreaterThan;
  if ('NumericEquals' in test) return (v) => typeof v === 'number' && v === test.NumericEquals;
  if ('NumericLessThan' in test) return (v) => typeof v === 'number' && v < test.NumericLessThan;
  if ('NumericGreaterThan' in test) return (v) => typeof v === 'number' && v > test.NumericGreaterThan;
  if ('NumericLessThanEquals' in test) return (v) => typeof v === 'number' && v <= test.NumericLessThanEquals;
  if ('NumericGreaterThanEquals' in test) return (v) => typeof v === 'number' && v >= test.NumericGreaterThanEquals;
  if ('BooleanEquals' in test) return (v) => typeof v === 'boolean' && v === test.BooleanEquals;
  if ('IsPresent' in test) return (v) => (v !== undefined) === test.IsPresent;
  return (v) => (v === null) === test.IsNull;
}
