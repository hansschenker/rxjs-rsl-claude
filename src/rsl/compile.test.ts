import { from, lastValueFrom, of, toArray } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { compile } from './compile.ts';
import { RslError } from './errors.ts';
import { mapFilter } from './examples.ts';
import type { TraceEvent } from './trace.ts';
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
    expect(events).toMatchObject([
      { kind: 'in', state: 'Double', tokenId: 0, value: 1 },
      { kind: 'out', state: 'Double', tokenId: 0, value: 2, target: 'Emit' },
      { kind: 'in', state: 'Emit', tokenId: 0, value: 2 },
      { kind: 'drop', state: 'Emit', tokenId: 0, value: 2, policy: 'Filter' },
      { kind: 'in', state: 'Double', tokenId: 1, value: 4 },
      { kind: 'out', state: 'Double', tokenId: 1, value: 8, target: 'Emit' },
      { kind: 'in', state: 'Emit', tokenId: 1, value: 8 },
      { kind: 'out', state: 'Emit', tokenId: 1, value: 8, target: '$output' },
    ]);
    for (const event of events) {
      expect(event.run).toBe('');
      expect(typeof event.at).toBe('number');
    }
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
    const events: TraceEvent[] = [];
    const op = compile(machine, {}, { trace: (e) => void events.push(e) });
    marbles().run(({ cold, expectObservable }) => {
      expectObservable(cold('a---------').pipe(op), '---!').toBe('----');
    });
    expect(events).toMatchObject([
      { kind: 'in', state: 'Emit', tokenId: 0, value: 'a', at: 0 },
      { kind: 'cancel', state: 'Emit', tokenId: 0, value: 'a', at: 3, reason: 'unsubscribe' },
    ]);
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

  it('errors the output stream on Fail when OnError is fail, tracing the error', () => {
    const events: TraceEvent[] = [];
    marbles().run(({ cold, expectObservable }) => {
      const op = compile(positiveOnly('fail'), {}, { trace: (e) => void events.push(e) });
      expectObservable(cold('a|', { a: -1 }).pipe(op)).toBe(
        '#',
        undefined,
        expect.objectContaining({ name: 'NotPositive', message: 'value must be > 0' }),
      );
    });
    expect(events.at(-1)).toMatchObject({
      kind: 'error',
      state: 'Boom',
      tokenId: 0,
      value: -1,
      onError: 'fail',
      error: expect.objectContaining({ name: 'NotPositive' }),
    });
  });

  it('drops only the failing token when OnError is drop, tracing it as an error', async () => {
    const onDrop = vi.fn();
    const events: TraceEvent[] = [];
    const op = compile(positiveOnly('drop'), {}, { onDrop, trace: (e) => void events.push(e) });
    const out = await lastValueFrom(from([1, -1, 2]).pipe(op, toArray()));
    expect(out).toEqual([1, 2]);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0]?.[0]).toMatchObject({ name: 'NotPositive' });
    expect(onDrop.mock.calls[0]?.[1]).toMatchObject({ value: -1 });
    const ended = events.filter((e) => e.kind === 'error' || e.kind === 'drop');
    expect(ended).toMatchObject([{ kind: 'error', state: 'Boom', tokenId: 1, value: -1, onError: 'drop' }]);
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
