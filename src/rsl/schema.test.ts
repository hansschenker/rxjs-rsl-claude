import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import schema from '../../rsl.schema.json';
import { examples } from './examples.ts';
import { validate } from './validate.ts';

/**
 * `rsl.schema.json` describes the JSON form of a document. These tests keep
 * it honest: it must compile under Ajv's strict mode, accept every example,
 * and reject the shapes `src/rsl/types.ts` forbids.
 */

const ajv = new Ajv2020({ allErrors: true });
const check = ajv.compile(schema);

/** Ajv's complaints for a document, empty when it conforms. */
function errors(document: unknown): string[] {
  if (check(document)) return [];
  return (check.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? ''}`.trim());
}

/** The example as it would arrive from a JSON file. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

describe('rsl.schema.json: the examples', () => {
  it.each(examples)('$name conforms to the schema', ({ machine }) => {
    expect(errors(asJson(machine))).toEqual([]);
  });

  it('agrees with validate() on the examples', () => {
    for (const { machine } of examples) expect(validate(machine)).toEqual([]);
  });

  it('accepts a document carrying the $schema editor hint', () => {
    expect(errors({ $schema: './rsl.schema.json', StartAt: 'A', States: { A: { Type: 'Succeed' } } })).toEqual([]);
  });
});

describe('rsl.schema.json: shapes it rejects', () => {
  const machine = (states: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown => ({
    StartAt: Object.keys(states)[0],
    States: states,
    ...extra,
  });

  it.each<[string, unknown]>([
    ['a missing StartAt', { States: { A: { Type: 'Succeed' } } }],
    ['an empty States object', { StartAt: 'A', States: {} }],
    ['an unknown machine field', machine({ A: { Type: 'Succeed' } }, { TimeoutSeconds: 5 })],
    ['a QueryLanguage other than JSONPath', machine({ A: { Type: 'Succeed' } }, { QueryLanguage: 'JSONata' })],
    ['an unknown OnError', machine({ A: { Type: 'Succeed' } }, { OnError: 'retry' })],
    ['an unknown state Type', machine({ A: { Type: 'Job', End: true } })],
    ['a state without a Type', machine({ A: { End: true } })],
    ['an unknown state field', machine({ A: { Type: 'Pass', Bogus: 1, End: true } })],
    ['both Next and End', machine({ A: { Type: 'Pass', Next: 'A', End: true } })],
    ['neither Next nor End', machine({ A: { Type: 'Pass' } })],
    ['End: false', machine({ A: { Type: 'Pass', End: false } })],
    ['Next on a Succeed', machine({ A: { Type: 'Succeed', Next: 'A' } })],
    ['a Task without a Resource', machine({ A: { Type: 'Task', End: true } })],
    ['a negative Debounce', machine({ A: { Type: 'Succeed', Debounce: -1 } })],
    ['a non-integer MaxConcurrency', machine({ A: { Type: 'Task', Resource: 'r', MaxConcurrency: 1.5, End: true } })],
    ['a Take of zero', machine({ A: { Type: 'Task', Resource: 'r', Take: 0, End: true } })],
    ['an unknown Concurrency', machine({ A: { Type: 'Task', Resource: 'r', Concurrency: 'latest', End: true } })],
    ['a Retrier without ErrorEquals', machine({ A: { Type: 'Task', Resource: 'r', Retry: [{ MaxAttempts: 1 }], End: true } })],
    ['a Catcher without Next', machine({ A: { Type: 'Task', Resource: 'r', Catch: [{ ErrorEquals: ['States.ALL'] }], End: true } })],
    ['a path outside the JSONPath subset', machine({ A: { Type: 'Pass', InputPath: 'a.b', End: true } })],
    ['a DistinctUntilChanged of false', machine({ A: { Type: 'Succeed', DistinctUntilChanged: false } })],
    ['a Wait with two timing fields', machine({ A: { Type: 'Wait', Seconds: 1, Timestamp: 't', End: true } })],
    ['a Wait with no timing field', machine({ A: { Type: 'Wait', End: true } })],
    ['a Choice with no rules', machine({ A: { Type: 'Choice', Choices: [] } })],
    ['a Choice rule without Next', machine({ A: { Type: 'Choice', Choices: [{ Variable: '$', IsNull: true }] } })],
    ['a data test with two comparisons', machine({ A: { Type: 'Choice', Choices: [{ Variable: '$', IsNull: true, IsPresent: true, Next: 'A' }] } })],
    ['a data test without a Variable', machine({ A: { Type: 'Choice', Choices: [{ IsNull: true, Next: 'A' }] } })],
    ['a comparison of the wrong type', machine({ A: { Type: 'Choice', Choices: [{ Variable: '$', NumericEquals: '1', Next: 'A' }] } })],
    ['an unknown key inside a Filter test', machine({ A: { Type: 'Succeed', Filter: { Variable: '$', IsNull: true, Next: 'A' } } })],
    ['an empty And', machine({ A: { Type: 'Succeed', Filter: { And: [] } } })],
    ['a Parallel with no branches', machine({ A: { Type: 'Parallel', Branches: [], End: true } })],
    ['an unknown Join', machine({ A: { Type: 'Parallel', Branches: [{ StartAt: 'B', States: { B: { Type: 'Succeed' } } }], Join: 'all', End: true } })],
    ['a Map without an ItemProcessor', machine({ A: { Type: 'Map', End: true } })],
    ['an unknown Collect', machine({ A: { Type: 'Map', ItemProcessor: { StartAt: 'B', States: { B: { Type: 'Succeed' } } }, Collect: 'list', End: true } })],
    ['a nested machine that breaks the same rules', machine({ A: { Type: 'Map', ItemProcessor: { StartAt: 'B', States: { B: { Type: 'Pass' } } }, End: true } })],
  ])('rejects %s', (_name, document) => {
    expect(errors(document)).not.toEqual([]);
  });

  it('points at the offending location', () => {
    expect(errors(machine({ A: { Type: 'Pass', InputPath: 'a.b', End: true } }))).toContainEqual(
      expect.stringContaining('/States/A/InputPath'),
    );
  });
});
