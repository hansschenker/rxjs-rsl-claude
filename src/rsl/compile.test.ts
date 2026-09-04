import { from, lastValueFrom, map, of, timer, toArray } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { compile } from './compile.ts';
import { RslError, StateError } from './errors.ts';
import { mapFilter, polling, pollingRegistry } from './examples.ts';
import type { TraceEvent } from './trace.ts';
import type { Common, Registry, RslMachine, RslState, WaitTiming } from './types.ts';

const registry: Registry = { transforms: { double: (n: number) => n * 2 } };

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
  it('rejects a missing registry name at run time too (the types catch it first)', () => {
    // @ts-expect-error mapFilter names a transform, so the typed registry must provide it
    expect(() => compile(mapFilter, {})).toThrow(RslError);
    // @ts-expect-error same call, checking the message
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

  it('rejects state types the runtime does not implement yet', () => {
    const machine: RslMachine = {
      StartAt: 'P',
      States: { P: { Type: 'Parallel', Branches: [{ StartAt: 'A', States: { A: { Type: 'Succeed' } } }], End: true } },
    };
    expect(() => compile(machine)).toThrow('Type "Parallel" is not implemented');
  });

  it('rejects a Wait whose constant Timestamp is not a date', () => {
    const machine: RslMachine = { StartAt: 'W', States: { W: { Type: 'Wait', Timestamp: 'someday', End: true } } };
    expect(() => compile(machine)).toThrow('Timestamp "someday" is not a valid date');
  });

  it('rejects a missing resource name and a resource that is neither a function nor a machine', () => {
    const machine: RslMachine = { StartAt: 'T', States: { T: { Type: 'Task', Resource: 'nope', End: true } } };
    expect(() => compile(machine, {})).toThrow('no resource named "nope"');
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
    const predicates: Registry = { predicates: { isThree: (n: number) => n === 3 } };
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
    const inc: Registry = { transforms: { inc: (n: number) => n + 1 } };
    expect(await lastValueFrom(of(0).pipe(compile<number, number>(machine, inc)))).toBe(20000);
  });
});

describe('compile: Task', () => {
  const task = (fields: Omit<Extract<RslState, { Type: 'Task' }>, 'Type' | 'End' | 'Next'>): RslMachine => ({
    StartAt: 'T',
    States: { T: { Type: 'Task', End: true, ...fields } },
  });

  it('calls the resource with InputPath, inserts the result at ResultPath and selects OutputPath', async () => {
    const machine = task({ Resource: 'status', InputPath: '$.id', ResultPath: '$.job', OutputPath: '$.job' });
    const registry: Registry = { resources: { status: (id: string) => of({ id, status: 'done' }) } };
    expect(await lastValueFrom(of({ id: 'j1', extra: true }).pipe(compile(machine, registry)))).toEqual({
      id: 'j1',
      status: 'done',
    });
  });

  it('emits one token per value of a multi-shot resource, all with the input token id, and Take limits them', async () => {
    const three: Registry = { resources: { three: (n: number) => from([n, n + 1, n + 2]) } };
    const events: TraceEvent[] = [];
    const op = compile(task({ Resource: 'three' }), three, { trace: (e) => void events.push(e) });
    expect(await lastValueFrom(from([10]).pipe(op, toArray()))).toEqual([10, 11, 12]);
    expect(events.filter((e) => e.kind === 'out').map((e) => e.tokenId)).toEqual([0, 0, 0]);
    expect(await lastValueFrom(from([10]).pipe(compile(task({ Resource: 'three', Take: 2 }), three), toArray()))).toEqual([
      10, 11,
    ]);
  });

  it('completes only once every resource has finished', () => {
    const registry: Registry = { resources: { slow: (v: unknown) => timer(5).pipe(map(() => v)) } };
    marbles().run(({ cold, expectObservable }) => {
      expectObservable(cold('a-b|').pipe(compile(task({ Resource: 'slow' }), registry))).toBe('-----a-(b|)');
    });
  });

  it('limits merge with MaxConcurrency, keeping the waiting tokens alive', () => {
    const registry: Registry = { resources: { slow: (v: unknown) => timer(10).pipe(map(() => v)) } };
    marbles().run(({ cold, expectObservable }) => {
      const op = compile(task({ Resource: 'slow', MaxConcurrency: 2 }), registry);
      expectObservable(cold('abc|').pipe(op)).toBe('10ms ab 8ms (c|)');
    });
  });

  it('reports a resource still running at unsubscribe as cancelled', () => {
    const registry: Registry = { resources: { slow: (v: unknown) => timer(10).pipe(map(() => v)) } };
    const events: TraceEvent[] = [];
    marbles().run(({ cold, expectObservable }) => {
      const op = compile(task({ Resource: 'slow' }), registry, { trace: (e) => void events.push(e) });
      expectObservable(cold('a---------').pipe(op), '---!').toBe('----');
    });
    expect(events.map((e) => e.kind)).toEqual(['in', 'cancel']);
    expect(events[1]).toMatchObject({ state: 'T', tokenId: 0, at: 3, reason: 'unsubscribe' });
  });

  it('routes an uncaught resource error through OnError', async () => {
    const machine: RslMachine = { ...task({ Resource: 'flaky' }), OnError: 'drop' };
    const registry: Registry = {
      resources: {
        flaky: (n: number) => {
          if (n === 2) throw new StateError('Boom', 'two is bad');
          return of(n);
        },
      },
    };
    const onDrop = vi.fn();
    const events: TraceEvent[] = [];
    const op = compile(machine, registry, { onDrop, trace: (e) => void events.push(e) });
    expect(await lastValueFrom(from([1, 2, 3]).pipe(op, toArray()))).toEqual([1, 3]);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.kind === 'error')).toMatchObject([
      { state: 'T', tokenId: 1, value: 2, onError: 'drop', error: expect.objectContaining({ name: 'Boom' }) },
    ]);
  });

  it('routes a caught error to the Catcher with { Error, Cause } at its ResultPath, default $', async () => {
    const machine: RslMachine = {
      StartAt: 'T',
      States: {
        T: { Type: 'Task', Resource: 'boom', Catch: [{ ErrorEquals: ['Boom'], Next: 'Report' }], End: true },
        Report: { Type: 'Pass', End: true },
      },
    };
    const registry: Registry = {
      resources: {
        boom: () => {
          throw new StateError('Boom', 'bad');
        },
      },
    };
    const events: TraceEvent[] = [];
    const op = compile(machine, registry, { trace: (e) => void events.push(e) });
    expect(await lastValueFrom(of('in').pipe(op))).toEqual({ Error: 'Boom', Cause: 'bad' });
    expect(events.filter((e) => e.kind === 'catch')).toMatchObject([
      { state: 'T', target: 'Report', value: { Error: 'Boom', Cause: 'bad' } },
    ]);
  });

  it('gives each Retrier its own counter and caps the backoff with MaxDelaySeconds', () => {
    const calls: string[][] = [];
    const registry = (script: string[]): Registry => ({
      resources: {
        r: () => {
          const next = script.shift();
          calls.push([...script]);
          if (next === undefined) return of('ok');
          throw new StateError(next);
        },
      },
    });
    const twoRetriers = task({
      Resource: 'r',
      Retry: [
        { ErrorEquals: ['A'], MaxAttempts: 1, IntervalSeconds: 1 },
        { ErrorEquals: ['B'], MaxAttempts: 1, IntervalSeconds: 1 },
      ],
    });
    marbles().run(({ cold, expectObservable }) => {
      // A then B: each Retrier retries once, so the third call succeeds at 2 s.
      expectObservable(cold('a|').pipe(compile(twoRetriers, registry(['A', 'B'])))).toBe('2s (x|)', { x: 'ok' });
    });
    marbles().run(({ cold, expectObservable }) => {
      // A then A: the A Retrier is exhausted after one retry, and there is no Catcher.
      expectObservable(cold('a|').pipe(compile(twoRetriers, registry(['A', 'A'])))).toBe(
        '1s #',
        undefined,
        expect.objectContaining({ name: 'A' }),
      );
    });
    const capped = task({
      Resource: 'r',
      Retry: [{ ErrorEquals: ['States.ALL'], MaxAttempts: 3, IntervalSeconds: 1, BackoffRate: 10, MaxDelaySeconds: 2 }],
    });
    const events: TraceEvent[] = [];
    marbles().run(({ cold, expectObservable }) => {
      // Delays 1 s, then 10 s capped to 2 s, then 2 s again: calls at 0, 1 s, 3 s and 5 s.
      const op = compile(capped, registry(['E', 'E', 'E']), { trace: (e) => void events.push(e) });
      expectObservable(cold('a|').pipe(op)).toBe('5s (x|)', { x: 'ok' });
    });
    expect(events.filter((e) => e.kind === 'retry').map((e) => [e.at, e.kind === 'retry' ? e.attempt : -1])).toEqual([
      [0, 1],
      [1000, 2],
      [3000, 3],
    ]);
  });

  it('runs a machine given as Resource once per token, prefixing its trace with the location and token id', async () => {
    const inner: RslMachine = {
      StartAt: 'Double',
      States: { Double: { Type: 'Pass', Transform: 'double', End: true } },
    };
    const outer: RslMachine = {
      StartAt: 'Wrap',
      States: { Wrap: { Type: 'Task', Resource: 'inner', InputPath: '$.n', ResultPath: '$.doubled', End: true } },
    };
    const registry: Registry = { resources: { inner }, transforms: { double: (n: number) => n * 2 } };
    const events: TraceEvent[] = [];
    const op = compile(outer, registry, { trace: (e) => void events.push(e) });
    expect(await lastValueFrom(from([{ n: 2 }, { n: 5 }]).pipe(op, toArray()))).toEqual([
      { n: 2, doubled: 4 },
      { n: 5, doubled: 10 },
    ]);
    expect(events.map((e) => `${e.run}|${e.kind} ${e.state} #${e.tokenId}`)).toEqual([
      '|in Wrap #0',
      'States.Wrap.Resource#0|in Double #0',
      'States.Wrap.Resource#0|out Double #0',
      '|out Wrap #0',
      '|in Wrap #1',
      'States.Wrap.Resource#1|in Double #0',
      'States.Wrap.Resource#1|out Double #0',
      '|out Wrap #1',
    ]);
  });

  it('lets a nested machine inherit OnError, or error the enclosing Task', async () => {
    const failing: RslMachine = { StartAt: 'Boom', States: { Boom: { Type: 'Fail', Error: 'Inner', Cause: 'no' } } };
    const registry: Registry = { resources: { failing } };
    const dropping: RslMachine = {
      StartAt: 'Wrap',
      OnError: 'drop',
      States: { Wrap: { Type: 'Task', Resource: 'failing', End: true } },
    };
    const onDrop = vi.fn();
    const events: TraceEvent[] = [];
    const op = compile(dropping, registry, { onDrop, trace: (e) => void events.push(e) });
    expect(await lastValueFrom(from([1]).pipe(op, toArray()))).toEqual([]);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.kind === 'error')).toMatchObject([
      { run: 'States.Wrap.Resource#0', state: 'Boom', onError: 'drop' },
    ]);

    const failingOuter: RslMachine = { ...dropping, OnError: 'fail' };
    await expect(lastValueFrom(from([1]).pipe(compile(failingOuter, registry)))).rejects.toMatchObject({ name: 'Inner' });
  });
});

describe('compile: Wait', () => {
  const wait = (timing: WaitTiming & Pick<Common, 'InputPath' | 'OutputPath'>): RslMachine => ({
    StartAt: 'W',
    States: { W: { Type: 'Wait', End: true, ...timing } },
  });

  it('holds each token for Seconds, passing it through', () => {
    marbles().run(({ cold, expectObservable }) => {
      expectObservable(cold('a-b|').pipe(compile(wait({ Seconds: 1 })))).toBe('1s a-(b|)');
    });
  });

  it('reads the duration from the token with SecondsPath, so tokens may overtake each other', () => {
    marbles().run(({ cold, expectObservable }) => {
      const source = cold('ab|', { a: { wait: 2 }, b: { wait: 1 } });
      expectObservable(source.pipe(compile(wait({ SecondsPath: '$.wait' })))).toBe('1001ms b 998ms (a|)', {
        a: { wait: 2 },
        b: { wait: 1 },
      });
    });
  });

  it('waits until an absolute Timestamp, or not at all when it has passed', () => {
    marbles().run(({ cold, expectObservable }) => {
      const at5s = wait({ Timestamp: new Date(5000).toISOString() });
      expectObservable(cold('a|').pipe(compile(at5s))).toBe('5s (a|)');
    });
    marbles().run(({ cold, expectObservable }) => {
      const source = cold('a|', { a: { until: new Date(0).toISOString() } });
      expectObservable(source.pipe(compile(wait({ TimestampPath: '$.until' })))).toBe('a|', {
        a: { until: new Date(0).toISOString() },
      });
    });
  });

  it('applies InputPath and OutputPath around the wait', async () => {
    const machine = wait({ Seconds: 0, InputPath: '$.inner', OutputPath: '$.value' });
    expect(await lastValueFrom(of({ inner: { value: 7 }, other: 1 }).pipe(compile(machine)))).toBe(7);
  });

  it('turns a token whose path is not a duration into a States.Runtime error for OnError', async () => {
    const machine: RslMachine = { ...wait({ SecondsPath: '$.wait' }), OnError: 'drop' };
    const events: TraceEvent[] = [];
    const op = compile(machine, {}, { trace: (e) => void events.push(e) });
    expect(await lastValueFrom(from([{ wait: 0 }, { wait: 'soon' }, { wait: -1 }]).pipe(op, toArray()))).toEqual([
      { wait: 0 },
    ]);
    expect(events.filter((e) => e.kind === 'error')).toMatchObject([
      { tokenId: 1, onError: 'drop', error: expect.objectContaining({ name: 'States.Runtime' }) },
      { tokenId: 2, onError: 'drop', error: expect.objectContaining({ name: 'States.Runtime' }) },
    ]);
  });

  it('reports a token still waiting at unsubscribe as cancelled', () => {
    const events: TraceEvent[] = [];
    marbles().run(({ cold, expectObservable }) => {
      const op = compile(wait({ Seconds: 1 }), {}, { trace: (e) => void events.push(e) });
      expectObservable(cold('a---------').pipe(op), '---!').toBe('----');
    });
    expect(events.map((e) => e.kind)).toEqual(['in', 'cancel']);
    expect(events[1]).toMatchObject({ state: 'W', tokenId: 0, at: 3, reason: 'unsubscribe' });
  });

  it('runs the polling example: Task → Choice → Wait → Task until the job is done', () => {
    const events: TraceEvent[] = [];
    marbles().run(({ cold, expectObservable }) => {
      const op = compile(polling, pollingRegistry, { trace: (e) => void events.push(e) });
      // Three polls two seconds apart: running at 0 and 2 s, done at 4 s.
      expectObservable(cold('a|', { a: { id: 'job-t' } }).pipe(op)).toBe('4s (a|)', {
        a: { id: 'job-t', job: { status: 'done', polls: 3 } },
      });
    });
    expect(events.filter((e) => e.kind === 'out' && e.state === 'Pause').map((e) => e.at)).toEqual([2000, 4000]);
    expect(events.filter((e) => e.kind === 'in' && e.state === 'GetStatus')).toHaveLength(3);
  });

  it('polls one job at a time when the loop is wrapped in a Task with exhaust (spec §8)', () => {
    const outer: RslMachine = {
      StartAt: 'Poll',
      States: { Poll: { Type: 'Task', Resource: 'poller', Concurrency: 'exhaust', End: true } },
    };
    const registry: Registry = { resources: { ...pollingRegistry.resources, poller: polling } };
    const events: TraceEvent[] = [];
    marbles().run(({ cold, expectObservable }) => {
      const op = compile(outer, registry, { trace: (e) => void events.push(e) });
      const source = cold('ab|', { a: { id: 'job-a' }, b: { id: 'job-b' } });
      expectObservable(source.pipe(op)).toBe('4s (a|)', { a: { id: 'job-a', job: { status: 'done', polls: 3 } } });
    });
    expect(events.filter((e) => e.kind === 'drop')).toMatchObject([
      { state: 'Poll', tokenId: 1, at: 1, policy: 'Concurrency' },
    ]);
    expect(events.filter((e) => e.run !== '').every((e) => e.run === 'States.Poll.Resource#0')).toBe(true);
  });
});
