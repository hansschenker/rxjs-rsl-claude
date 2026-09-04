import { describe, expect, it } from 'vitest';
import { RslError } from './errors.ts';
import { examples, mapFilter } from './examples.ts';
import type { RslMachine } from './types.ts';
import { assertValid, validate } from './validate.ts';

/** Build a document the way a JSON file would arrive: without the TypeScript types vouching for it. */
const doc = (value: unknown): RslMachine => value as RslMachine;

const paths = (machine: RslMachine): string[] => validate(machine).map((issue) => issue.path);

describe('validate: well-formed documents', () => {
  it.each(examples)('$name has no issues', ({ machine }) => {
    expect(validate(machine)).toEqual([]);
  });

  it('accepts a cycle, a Catch edge and a nested machine resource', () => {
    const machine: RslMachine = {
      StartAt: 'Get',
      States: {
        Get: {
          Type: 'Task',
          Resource: { StartAt: 'Inner', States: { Inner: { Type: 'Succeed' } } },
          Retry: [{ ErrorEquals: ['States.Timeout'] }, { ErrorEquals: ['States.ALL'] }],
          Catch: [{ ErrorEquals: ['States.ALL'], Next: 'Bail' }],
          Next: 'Check',
        },
        Check: { Type: 'Choice', Choices: [{ Variable: '$.done', BooleanEquals: true, Next: 'Done' }], Default: 'Get' },
        Done: { Type: 'Succeed' },
        Bail: { Type: 'Fail', Error: 'GaveUp' },
      },
    };
    expect(validate(machine)).toEqual([]);
  });
});

describe('validate: machine-level rules', () => {
  it('reports a StartAt that is not a state', () => {
    const machine: RslMachine = { StartAt: 'Missing', States: { A: { Type: 'Succeed' } } };
    expect(validate(machine)).toEqual([{ path: 'StartAt', message: 'StartAt "Missing" is not a state in States' }]);
  });

  it('reports an empty States object and stops there', () => {
    expect(validate(doc({ StartAt: 'A', States: {} }))).toEqual([
      { path: 'States', message: 'must contain at least one state' },
    ]);
  });

  it('reports a QueryLanguage other than JSONPath and an unknown OnError', () => {
    const machine = doc({ StartAt: 'A', QueryLanguage: 'JSONata', OnError: 'retry', States: { A: { Type: 'Succeed' } } });
    expect(paths(machine)).toEqual(['QueryLanguage', 'OnError']);
  });

  it('reports states that StartAt cannot reach, following Choice and Catch edges', () => {
    const machine: RslMachine = {
      StartAt: 'A',
      States: {
        A: { Type: 'Task', Resource: 'r', Catch: [{ ErrorEquals: ['States.ALL'], Next: 'Caught' }], Next: 'Route' },
        Route: { Type: 'Choice', Choices: [{ Variable: '$', IsPresent: true, Next: 'Yes' }], Default: 'No' },
        Yes: { Type: 'Succeed' },
        No: { Type: 'Succeed' },
        Caught: { Type: 'Succeed' },
        Orphan: { Type: 'Pass', Next: 'Yes' },
      },
    };
    expect(validate(machine)).toEqual([{ path: 'States.Orphan', message: 'not reachable from StartAt "A"' }]);
  });
});

describe('validate: transitions', () => {
  it('reports targets that do not exist, with the field that names them', () => {
    const machine: RslMachine = {
      StartAt: 'A',
      States: {
        A: { Type: 'Task', Resource: 'r', Catch: [{ ErrorEquals: ['States.ALL'], Next: 'NoCatch' }], Next: 'Route' },
        Route: { Type: 'Choice', Choices: [{ Variable: '$', IsNull: false, Next: 'NoRule' }], Default: 'NoDefault' },
      },
    };
    expect(validate(machine)).toEqual([
      { path: 'States.A.Catch[0].Next', message: 'target state "NoCatch" does not exist' },
      { path: 'States.Route.Choices[0].Next', message: 'target state "NoRule" does not exist' },
      { path: 'States.Route.Default', message: 'target state "NoDefault" does not exist' },
    ]);
  });

  it('requires exactly one of Next and End: true', () => {
    const both = doc({ StartAt: 'A', States: { A: { Type: 'Pass', Next: 'B', End: true }, B: { Type: 'Succeed' } } });
    expect(validate(both)).toEqual([
      { path: 'States.A', message: 'has both Next and End: true; a state takes exactly one' },
    ]);
    const neither = doc({ StartAt: 'A', States: { A: { Type: 'Pass' } } });
    expect(validate(neither)).toEqual([{ path: 'States.A', message: 'needs either Next or End: true' }]);
  });

  it('rejects Next and End on Choice, Succeed and Fail', () => {
    const machine = doc({
      StartAt: 'Route',
      States: {
        Route: { Type: 'Choice', Choices: [{ Variable: '$', IsPresent: true, Next: 'Ok' }], Next: 'Ok' },
        Ok: { Type: 'Succeed', End: true },
      },
    });
    expect(validate(machine)).toEqual([
      { path: 'States.Route', message: 'a Choice state takes neither Next nor End' },
      { path: 'States.Ok', message: 'a Succeed state takes neither Next nor End' },
    ]);
  });
});

describe('validate: per-type rules', () => {
  it('rejects an unknown Type and an empty Choices list', () => {
    const machine = doc({
      StartAt: 'A',
      States: { A: { Type: 'Job', Next: 'B' }, B: { Type: 'Choice', Choices: [] } },
    });
    expect(validate(machine)).toEqual([
      { path: 'States.A.Type', message: 'unknown state type "Job"' },
      { path: 'States.B.Choices', message: 'must contain at least one rule' },
      { path: 'States.B', message: 'not reachable from StartAt "A"' },
    ]);
  });

  it('keeps States.ALL last and alone in Retry and Catch lists', () => {
    const machine: RslMachine = {
      StartAt: 'T',
      States: {
        T: {
          Type: 'Task',
          Resource: 'r',
          Retry: [{ ErrorEquals: ['States.ALL'] }, { ErrorEquals: ['States.Timeout'] }],
          Catch: [{ ErrorEquals: ['States.Timeout', 'States.ALL'], Next: 'T' }],
          End: true,
        },
      },
    };
    expect(validate(machine)).toEqual([
      { path: 'States.T.Retry[0].ErrorEquals', message: 'States.ALL must be in the last entry' },
      { path: 'States.T.Catch[0].ErrorEquals', message: 'States.ALL must be alone in its ErrorEquals' },
    ]);
  });

  it('requires exactly one Wait timing field', () => {
    const two = doc({ StartAt: 'W', States: { W: { Type: 'Wait', Seconds: 1, Timestamp: '2026-01-01T00:00:00Z', End: true } } });
    const none = doc({ StartAt: 'W', States: { W: { Type: 'Wait', End: true } } });
    const message = 'needs exactly one of Seconds, Timestamp, SecondsPath, TimestampPath';
    expect(validate(two)).toEqual([{ path: 'States.W', message }]);
    expect(validate(none)).toEqual([{ path: 'States.W', message }]);
  });

  it('checks every path field against the JSONPath subset', () => {
    const machine: RslMachine = {
      StartAt: 'A',
      States: {
        A: { Type: 'Pass', InputPath: 'a.b', ResultPath: '$[*]', DistinctUntilChanged: '$.', Next: 'B' },
        B: {
          Type: 'Succeed',
          Filter: { And: [{ Variable: 'nope', IsPresent: true }, { Not: { Condition: 'p' } }] },
        },
      },
    };
    expect(paths(machine)).toEqual([
      'States.A.InputPath',
      'States.A.DistinctUntilChanged',
      'States.A.ResultPath',
      'States.B.Filter.And[0].Variable',
    ]);
    expect(validate(machine)[0]?.message).toBe('Invalid path "a.b": must start with $');
  });

  it('rejects a test that is neither a data test nor a combinator', () => {
    const machine = doc({
      StartAt: 'Route',
      States: { Route: { Type: 'Choice', Choices: [{ Next: 'Ok' }] }, Ok: { Type: 'Succeed' } },
    });
    expect(validate(machine)).toEqual([
      { path: 'States.Route.Choices[0]', message: 'must be a data test (Variable + comparison), a Condition, or And / Or / Not' },
    ]);
  });
});

describe('validate: nested machines', () => {
  it('validates branches, item processors and machine resources with prefixed paths', () => {
    const machine: RslMachine = {
      StartAt: 'P',
      States: {
        P: {
          Type: 'Parallel',
          Branches: [
            { StartAt: 'X', States: { X: { Type: 'Pass', Next: 'Gone' } } },
            { StartAt: 'Nope', States: { Y: { Type: 'Succeed' } } },
          ],
          Next: 'M',
        },
        M: {
          Type: 'Map',
          ItemProcessor: { StartAt: 'I', States: { I: { Type: 'Wait', Seconds: 1, Next: 'Lost' } } },
          Next: 'T',
        },
        T: { Type: 'Task', Resource: { StartAt: 'R', States: { R: { Type: 'Fail', Error: 'x' }, Extra: { Type: 'Succeed' } } }, End: true },
      },
    };
    expect(validate(machine)).toEqual([
      { path: 'States.P.Branches[0].States.X.Next', message: 'target state "Gone" does not exist' },
      { path: 'States.P.Branches[1].StartAt', message: 'StartAt "Nope" is not a state in States' },
      { path: 'States.M.ItemProcessor.States.I.Next', message: 'target state "Lost" does not exist' },
      { path: 'States.T.Resource.States.Extra', message: 'not reachable from StartAt "R"' },
    ]);
  });

  it('reports an empty Branches list and a missing ItemProcessor', () => {
    const machine = doc({
      StartAt: 'P',
      States: { P: { Type: 'Parallel', Branches: [], Next: 'M' }, M: { Type: 'Map', End: true } },
    });
    expect(paths(machine)).toEqual(['States.P.Branches', 'States.M.ItemProcessor']);
  });
});

describe('assertValid', () => {
  it('returns silently for a valid document', () => {
    expect(() => assertValid(mapFilter)).not.toThrow();
  });

  it('throws one RslError naming a single issue inline', () => {
    const machine: RslMachine = { StartAt: 'A', States: { A: { Type: 'Pass', Next: 'Nowhere' } } };
    expect(() => assertValid(machine)).toThrow(RslError);
    expect(() => assertValid(machine)).toThrow('Invalid RSL document: States.A.Next: target state "Nowhere" does not exist');
  });

  it('lists every issue when there are several', () => {
    const machine = doc({ StartAt: 'Missing', States: { A: { Type: 'Pass', Next: 'B', End: true }, B: { Type: 'Succeed' } } });
    expect(() => assertValid(machine)).toThrow(
      [
        'Invalid RSL document:',
        '  StartAt: StartAt "Missing" is not a state in States',
        '  States.A: has both Next and End: true; a state takes exactly one',
      ].join('\n'),
    );
  });
});
