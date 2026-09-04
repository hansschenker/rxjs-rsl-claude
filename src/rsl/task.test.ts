import { NEVER, map, timer } from 'rxjs';
import { TestScheduler } from 'rxjs/testing';
import { describe, expect, it } from 'vitest';
import { compile } from './compile.ts';
import { checkout, checkoutRegistry, checkoutResources } from './examples.ts';
import type { Order, Validated } from './examples.ts';
import type { RegistryFor } from './registry.ts';
import type { TraceEvent } from './trace.ts';
import type { Concurrency, Registry, RslMachine } from './types.ts';

/**
 * Acceptance tests for the Task slice (spec §12 step 1): the four
 * `Concurrency` policies on a slow resource, and the checkout example end to
 * end (Catch with ResultPath, TimeoutSeconds, Retry with backoff, concat).
 * Written before the slice landed; they ran unchanged once it did.
 */

function marbles(): TestScheduler {
  return new TestScheduler((actual, expected) => expect(actual).toEqual(expected));
}

describe('Task: Concurrency', () => {
  /** One Task whose resource takes 10 frames and echoes its input. */
  const machine = (mode: Concurrency): RslMachine => ({
    StartAt: 'Slow',
    States: { Slow: { Type: 'Task', Resource: 'slow', Concurrency: mode, End: true } },
  });
  const registry: Registry = { resources: { slow: (value: unknown) => timer(10).pipe(map(() => value)) } };

  it('merge overlaps successive tokens', () => {
    marbles().run(({ cold, expectObservable }) => {
      expectObservable(cold('a-b|').pipe(compile(machine('merge'), registry))).toBe('----------a-(b|)');
    });
  });

  it('concat queues a token until the current resource completes', () => {
    marbles().run(({ cold, expectObservable }) => {
      expectObservable(cold('a-b|').pipe(compile(machine('concat'), registry))).toBe('----------a---------(b|)');
    });
  });

  it('switch cancels the in-flight token when a newer one arrives', () => {
    const events: TraceEvent[] = [];
    marbles().run(({ cold, expectObservable }) => {
      const op = compile(machine('switch'), registry, { trace: (e) => void events.push(e) });
      expectObservable(cold('a-b|').pipe(op)).toBe('------------(b|)');
    });
    expect(events.filter((e) => e.kind === 'cancel')).toMatchObject([
      { state: 'Slow', tokenId: 0, value: 'a', at: 2, reason: 'switch' },
    ]);
  });

  it('exhaust ignores a token that arrives while one is in flight', () => {
    const events: TraceEvent[] = [];
    marbles().run(({ cold, expectObservable }) => {
      const op = compile(machine('exhaust'), registry, { trace: (e) => void events.push(e) });
      expectObservable(cold('a-b|').pipe(op)).toBe('----------(a|)');
    });
    expect(events.filter((e) => e.kind === 'drop')).toMatchObject([
      { state: 'Slow', tokenId: 1, value: 'b', at: 2, policy: 'Concurrency' },
    ]);
  });
});

describe('Task: the checkout example', () => {
  const order = (id: string, amount = 49): Order => ({ id, amount, email: `${id}@example.com` });
  const validated = (o: Order): object => ({ ...o, valid: true });
  const charged = (o: Order): object => ({ ...validated(o), paymentId: `pay_${o.id}` });
  const kinds = (events: TraceEvent[]): string[] => events.map((e) => `${e.kind} ${e.state}`);

  /** The example registry with a `charge` that hangs for its first `hangs` calls, so each of those ends in States.Timeout. */
  function flakyCharge(hangs: number): RegistryFor<typeof checkout> {
    let calls = 0;
    return {
      resources: {
        ...checkoutResources,
        charge: (order: Validated) => (++calls <= hangs ? NEVER : checkoutResources.charge(order)),
      },
    };
  }

  it('validates, charges and notifies a good order', () => {
    const events: TraceEvent[] = [];
    marbles().run(({ cold, expectObservable }) => {
      const op = compile(checkout, checkoutRegistry, { trace: (e) => void events.push(e) });
      expectObservable(cold('a|', { a: order('ord_1') }).pipe(op)).toBe('10ms (a|)', {
        a: { ...charged(order('ord_1')), notified: true },
      });
    });
    expect(kinds(events)).toEqual(['in Validate', 'out Validate', 'in Charge', 'out Charge', 'in Notify', 'out Notify']);
  });

  it('routes a ValidationError to Reject with the error beside the order', () => {
    const events: TraceEvent[] = [];
    const bad = order('ord_2', 0);
    marbles().run(({ cold, expectObservable }) => {
      const op = compile(checkout, checkoutRegistry, { trace: (e) => void events.push(e) });
      // Rejected synchronously at frame 0; the machine completes with its source, one frame later.
      expectObservable(cold('a|', { a: bad }).pipe(op)).toBe('a|', {
        a: { ...bad, error: { Error: 'ValidationError', Cause: 'order ord_2: amount must be positive' }, rejected: true },
      });
    });
    expect(kinds(events)).toEqual(['in Validate', 'catch Validate', 'in Reject', 'out Reject']);
    expect(events[1]).toMatchObject({
      kind: 'catch',
      target: 'Reject',
      error: expect.objectContaining({ name: 'ValidationError' }),
    });
  });

  it('retries a timed-out charge with backoff, then notifies', () => {
    const events: TraceEvent[] = [];
    marbles().run(({ cold, expectObservable }) => {
      const op = compile(checkout, flakyCharge(2), { trace: (e) => void events.push(e) });
      // Call 1 at 0 times out at 5000, retry after 1 s; call 2 at 6000 times out at 11000, retry after 2 s;
      // call 3 at 13000 answers 10 frames later.
      expectObservable(cold('a|', { a: order('ord_3') }).pipe(op)).toBe('13010ms (a|)', {
        a: { ...charged(order('ord_3')), notified: true },
      });
    });
    expect(events.filter((e) => e.kind === 'retry')).toMatchObject([
      { state: 'Charge', tokenId: 0, at: 5000, attempt: 1, error: expect.objectContaining({ name: 'TimeoutError' }) },
      { state: 'Charge', tokenId: 0, at: 11000, attempt: 2, error: expect.objectContaining({ name: 'TimeoutError' }) },
    ]);
  });

  it('gives up after MaxAttempts and routes States.Timeout to Reject', () => {
    const events: TraceEvent[] = [];
    const o = order('ord_4');
    marbles().run(({ cold, expectObservable }) => {
      const op = compile(checkout, flakyCharge(Infinity), { trace: (e) => void events.push(e) });
      // Calls at 0, 6000, 13000 and 22000; the fourth times out at 27000 with no retries left.
      expectObservable(cold('a|', { a: o }).pipe(op)).toBe('27000ms (a|)', {
        a: { ...validated(o), error: { Error: 'States.Timeout', Cause: expect.any(String) }, rejected: true },
      });
    });
    expect(events.filter((e) => e.kind === 'retry').map((e) => e.at)).toEqual([5000, 11000, 18000]);
    expect(events.filter((e) => e.kind === 'catch')).toMatchObject([{ state: 'Charge', at: 27000, target: 'Reject' }]);
    expect(kinds(events)).not.toContain('in Notify');
  });

  it('charges one order at a time, in arrival order', () => {
    marbles().run(({ cold, expectObservable }) => {
      const source = cold('ab|', { a: order('ord_5'), b: order('ord_6') });
      expectObservable(source.pipe(compile(checkout, checkoutRegistry))).toBe('10ms a 9ms (b|)', {
        a: { ...charged(order('ord_5')), notified: true },
        b: { ...charged(order('ord_6')), notified: true },
      });
    });
  });
});
