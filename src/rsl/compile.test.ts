import { from, lastValueFrom, of, toArray } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { compile } from './compile.ts';
import type { TraceEvent } from './compile.ts';
import { RslError } from './errors.ts';
import { mapFilter } from './examples.ts';
import type { Registry, RslMachine } from './types.ts';

const registry: Registry = { transforms: { double: (n) => (n as number) * 2 } };

function marbles(): TestScheduler {
  return new TestScheduler((actual, expected) => expect(actual).toEqual(expected));
}

/** Choice → Succeed for positive numbers, Fail otherwise. */
function positiveOnly(onError: 'fail' | 'drop'): RslMachine {
  return {
    StartAt: 'Check',
    OnError: onError,
    States: {
      Check: { Type: 'Choice', Choices: [{ Variable: '$', NumericGreaterThan: 0, Next: 'Emit' }], Default: 'Boom' },
      Emit: { Type: 'Succeed' },
      Boom: { Type: 'Fail', Error: 'NotPositive', Cause: 'value must be > 0' },
    },
  };
}

describe('compile: the map + filter example', () => {
  it('runs from([1..5]) through map(double) and filter(> 6) to 8, 10', async () => {
    const out = await lastValueFrom(from([1, 2, 3, 4, 5]).pipe(compile<number, number>(mapFilter, registry), toArray()));
    expect(out).toEqual([8, 10]);
  });

  it('behaves like map + filter in marble time, completing with the source', () => {
    marbles().run(({ cold, expectObservable }) => {
      const source = cold('a-b-c-d-e|', { a: 1, b: 2, c: 3, d: 4, e: 5 });
      expectObservable(source.pipe(compile<number, number>(mapFilter, registry))).toBe('------d-e|', { d: 8, e: 10 });
    });
  });

  it('traces every token entering, leaving, or being dropped at a state', async () => {
    const events: TraceEvent[] = [];
    const trace = (event: TraceEvent): void => {
      events.push(event);
    };
    await lastValueFrom(from([1, 4]).pipe(compile<number, number>(mapFilter, registry, { trace }), toArray()));
    expect(events.map((e) => `${e.kind} ${e.state} ${String(e.value)}`)).toEqual([
      'in Double 1',
      'out Double 2',
      'in Emit 2',
      'drop Emit 2',
      'in Double 4',
      'out Double 8',
      'in Emit 8',
      'out Emit 8',
    ]);
    expect(events.map((e) => e.tokenId)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });
});

describe('compile: compile-time errors', () => {
  it('rejects a missing registry name', () => {
    expect(() => compile(mapFilter, {})).toThrow(RslError);
    expect(() => compile(mapFilter, {})).toThrow('no transform named "double"');
  });

  it('rejects a Next target that does not exist', () => {
    const machine: RslMachine = { StartAt: 'A', States: { A: { Type: 'Pass', Next: 'Nowhere' } } };
    expect(() => compile(machine)).toThrow('target state "Nowhere" does not exist');
  });

  it('rejects a StartAt that does not exist', () => {
    const machine: RslMachine = { StartAt: 'Missing', States: { A: { Type: 'Succeed' } } };
    expect(() => compile(machine)).toThrow('StartAt "Missing"');
  });

  it('rejects state types this slice does not implement yet', () => {
    const machine: RslMachine = { StartAt: 'T', States: { T: { Type: 'Task', Resource: 'x', End: true } } };
    expect(() => compile(machine)).toThrow('Type "Task" is not implemented');
  });

  it('rejects reserved JSONata conditions', () => {
    const machine: RslMachine = { StartAt: 'E', States: { E: { Type: 'Succeed', Filter: '{% $ > 1 %}' } } };
    expect(() => compile(machine)).toThrow('JSONata');
  });
});

describe('compile: Pass and paths', () => {
  it('applies InputPath, ResultPath and OutputPath with ASL semantics', async () => {
    const machine: RslMachine = {
      StartAt: 'Double',
      States: { Double: { Type: 'Pass', InputPath: '$.n', Transform: 'double', ResultPath: '$.doubled', End: true } },
    };
    const out = await lastValueFrom(of({ n: 2, tag: 'x' }).pipe(compile(machine, registry)));
    expect(out).toEqual({ n: 2, tag: 'x', doubled: 4 });
  });

  it('uses a constant Result and passes the input through otherwise', async () => {
    const machine: RslMachine = {
      StartAt: 'Const',
      States: { Const: { Type: 'Pass', Result: { ok: true }, Next: 'Same' }, Same: { Type: 'Pass', End: true } },
    };
    expect(await lastValueFrom(of(1).pipe(compile(machine)))).toEqual({ ok: true });
  });
});

describe('compile: input shaping', () => {
  it('debounces on the inbox and drops superseded tokens the moment they are superseded', () => {
    const machine: RslMachine = { StartAt: 'Emit', States: { Emit: { Type: 'Succeed', Debounce: 3 } } };
    const drops: number[] = [];
    const op = compile<string, string>(machine, {}, {
      trace: (e) => {
        if (e.kind === 'drop') drops.push(e.at);
      },
    });
    marbles().run(({ cold, expectObservable }) => {
      expectObservable(cold('a-b-c----|').pipe(op)).toBe('-------c-|');
    });
    expect(drops).toEqual([2, 4]);
  });

  it('throttles on the leading edge', () => {
    const machine: RslMachine = { StartAt: 'Emit', States: { Emit: { Type: 'Succeed', Throttle: 5 } } };
    marbles().run(({ cold, expectObservable }) => {
      expectObservable(cold('a-b-c-----d|').pipe(compile(machine))).toBe('a---------d|');
    });
  });

  it('skips repeats with DistinctUntilChanged, by value or by key', async () => {
    const byValue: RslMachine = { StartAt: 'Emit', States: { Emit: { Type: 'Succeed', DistinctUntilChanged: true } } };
    expect(await lastValueFrom(from([1, 1, 2, 2, 1]).pipe(compile(byValue), toArray()))).toEqual([1, 2, 1]);

    const byKey: RslMachine = { StartAt: 'Emit', States: { Emit: { Type: 'Succeed', DistinctUntilChanged: '$.id' } } };
    const items = [{ id: 1, v: 'a' }, { id: 1, v: 'b' }, { id: 2, v: 'c' }];
    expect(await lastValueFrom(from(items).pipe(compile(byKey), toArray()))).toEqual([items[0], items[2]]);
  });

  it('cancels a pending debounce on unsubscribe', () => {
    const machine: RslMachine = { StartAt: 'Emit', States: { Emit: { Type: 'Succeed', Debounce: 10 } } };
    const kinds: string[] = [];
    const op = compile(machine, {}, { trace: (e) => void kinds.push(e.kind) });
    marbles().run(({ cold, expectObservable }) => {
      expectObservable(cold('a---------').pipe(op), '---!').toBe('----');
    });
    expect(kinds).toEqual(['in']);
  });
});

describe('compile: Choice, Fail and OnError', () => {
  it('routes by the first matching rule, then Default', async () => {
    const machine: RslMachine = {
      StartAt: 'Route',
      States: {
        Route: {
          Type: 'Choice',
          Choices: [
            { Variable: '$', NumericLessThan: 0, Next: 'Neg' },
            { Variable: '$', NumericLessThan: 10, Next: 'Small' },
          ],
          Default: 'Big',
        },
        Neg: { Type: 'Pass', Result: 'neg', End: true },
        Small: { Type: 'Pass', Result: 'small', End: true },
        Big: { Type: 'Pass', Result: 'big', End: true },
      },
    };
    expect(await lastValueFrom(from([-1, 5, 50]).pipe(compile(machine), toArray()))).toEqual(['neg', 'small', 'big']);
  });

  it('errors with States.NoChoiceMatched when nothing matches and there is no Default', () => {
    const machine: RslMachine = {
      StartAt: 'Route',
      States: { Route: { Type: 'Choice', Choices: [{ Variable: '$', IsNull: true, Next: 'Emit' }] }, Emit: { Type: 'Succeed' } },
    };
    marbles().run(({ cold, expectObservable }) => {
      expectObservable(cold('a|', { a: 1 }).pipe(compile(machine))).toBe(
        '#',
        undefined,
        expect.objectContaining({ name: 'States.NoChoiceMatched' }),
      );
    });
  });

  it('errors the output stream on Fail when OnError is fail', () => {
    marbles().run(({ cold, expectObservable }) => {
      expectObservable(cold('a|', { a: -1 }).pipe(compile(positiveOnly('fail')))).toBe(
        '#',
        undefined,
        expect.objectContaining({ name: 'NotPositive', message: 'value must be > 0' }),
      );
    });
  });

  it('drops only the failing token when OnError is drop', async () => {
    const onDrop = vi.fn();
    const out = await lastValueFrom(from([1, -1, 2]).pipe(compile(positiveOnly('drop'), {}, { onDrop }), toArray()));
    expect(out).toEqual([1, 2]);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0]?.[0]).toMatchObject({ name: 'NotPositive' });
    expect(onDrop.mock.calls[0]?.[1]).toMatchObject({ value: -1 });
  });

  it('supports And / Or / Not and registry predicates', async () => {
    const machine: RslMachine = {
      StartAt: 'Emit',
      States: {
        Emit: {
          Type: 'Succeed',
          Filter: { And: [{ Variable: '$', NumericGreaterThan: 0 }, { Not: { Condition: 'isThree' } }] },
        },
      },
    };
    const predicates: Registry = { predicates: { isThree: (n) => n === 3 } };
    expect(await lastValueFrom(from([-1, 2, 3, 4]).pipe(compile(machine, predicates), toArray()))).toEqual([2, 4]);
  });
});

describe('compile: cycles', () => {
  it('iterates a synchronous cycle without recursing', async () => {
    const machine: RslMachine = {
      StartAt: 'Inc',
      States: {
        Inc: { Type: 'Pass', Transform: 'inc', Next: 'Check' },
        Check: { Type: 'Choice', Choices: [{ Variable: '$', NumericGreaterThanEquals: 20000, Next: 'Done' }], Default: 'Inc' },
        Done: { Type: 'Succeed' },
      },
    };
    const inc: Registry = { transforms: { inc: (n) => (n as number) + 1 } };
    expect(await lastValueFrom(of(0).pipe(compile<number, number>(machine, inc)))).toBe(20000);
  });
});
