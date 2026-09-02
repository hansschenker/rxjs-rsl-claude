import type { Concurrency, PredicateFn, Ref, RslMachine, Test } from './types.ts';

/** Anything a document field may reference: a registry name, an inline function, or a nested machine. */
type Referenced = string | ((input: never) => unknown) | RslMachine | undefined;

/** Human-readable name for a reference. Functions render as `fn`, which is why registry names are preferred. */
export function refName(ref: Referenced): string {
  if (ref === undefined) return '';
  if (typeof ref === 'string') return ref;
  if (typeof ref === 'function') return 'fn';
  return `machine(${ref.StartAt})`;
}

const FLATTEN: Record<Concurrency, string> = {
  merge: 'mergeMap',
  switch: 'switchMap',
  concat: 'concatMap',
  exhaust: 'exhaustMap',
};

/** The RxJS flattening operator a `Concurrency` policy stands for. */
export function flattenName(concurrency: Concurrency | undefined): string {
  return FLATTEN[concurrency ?? 'merge'];
}

/** Plain-text rendering of a Choice rule, a Filter, or a Condition. */
export function testLabel(test: Test | Ref<PredicateFn>): string {
  if (typeof test === 'string') return test.startsWith('{%') ? `jsonata(${test})` : `when(${test})`;
  if (typeof test === 'function') return 'when(fn)';
  if ('And' in test) return `(${test.And.map(testLabel).join(' and ')})`;
  if ('Or' in test) return `(${test.Or.map(testLabel).join(' or ')})`;
  if ('Not' in test) return `not ${testLabel(test.Not)}`;
  if ('Condition' in test) return testLabel(test.Condition);
  const v = test.Variable;
  if ('StringEquals' in test) return `${v} == "${test.StringEquals}"`;
  if ('StringLessThan' in test) return `${v} < "${test.StringLessThan}"`;
  if ('StringGreaterThan' in test) return `${v} > "${test.StringGreaterThan}"`;
  if ('NumericEquals' in test) return `${v} == ${test.NumericEquals}`;
  if ('NumericLessThan' in test) return `${v} < ${test.NumericLessThan}`;
  if ('NumericGreaterThan' in test) return `${v} > ${test.NumericGreaterThan}`;
  if ('NumericLessThanEquals' in test) return `${v} <= ${test.NumericLessThanEquals}`;
  if ('NumericGreaterThanEquals' in test) return `${v} >= ${test.NumericGreaterThanEquals}`;
  if ('BooleanEquals' in test) return `${v} == ${test.BooleanEquals}`;
  if ('IsPresent' in test) return test.IsPresent ? `${v} present` : `${v} absent`;
  return test.IsNull ? `${v} is null` : `${v} not null`;
}
