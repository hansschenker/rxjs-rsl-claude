import { RslError } from './errors.ts';
import { getPath } from './paths.ts';
import type { DataTest, KeyFn, PredicateFn, Ref, Registry, Test } from './types.ts';

/**
 * Resolve a document reference at compile time: a function is returned as is,
 * a string is looked up in the given registry bucket. Missing names and
 * reserved JSONata strings fail here, not at run time.
 */
export function resolveRef<F>(ref: Ref<F>, bucket: Record<string, F> | undefined, kind: string, where: string): F {
  if (typeof ref !== 'string') return ref as F;
  if (ref.startsWith('{%')) {
    throw new RslError(`${where}: JSONata expressions ({% ... %}) are reserved and not evaluated in v0`);
  }
  const fn = bucket?.[ref];
  if (fn === undefined) throw new RslError(`${where}: no ${kind} named "${ref}" in the registry`);
  return fn;
}

/** The comparison key for `DistinctUntilChanged`: identity, a `$`-path, or a key function. */
export function resolveKey(ref: true | string | KeyFn, registry: Registry, where: string): KeyFn {
  if (ref === true) return (value) => value;
  if (typeof ref === 'string' && ref.startsWith('$')) return (value) => getPath(value, ref);
  return resolveRef(ref, registry.keys, 'key', where);
}

/** Compile a Choice rule, a `Filter`, or a `Condition` into a predicate over the token value. */
export function compileTest(test: Test | Ref<PredicateFn>, registry: Registry, where: string): PredicateFn {
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

function compileDataTest(test: DataTest): PredicateFn {
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
