import { map, of, timer } from 'rxjs';
import { StateError } from './errors.ts';
import type { Registry, ResourceFn, RslMachine } from './types.ts';

/**
 * The spec's example documents, type-checked against the schema.
 * All references are registry names so the diagrams stay readable.
 */

/**
 * from([1, 2, 3, 4, 5]).pipe(map(n => n * 2), filter(n => n > 6))
 *
 * The source stays outside the document: `from([1,2,3,4,5]).pipe(compile(mapFilter, registry))`
 * with `registry.transforms.double = n => n * 2`. Emits 8 and 10.
 */
export const mapFilter: RslMachine = {
  Comment: 'map(n => n * 2), then keep only n > 6. The source from([1,2,3,4,5]) is piped into the machine.',
  StartAt: 'Double',
  States: {
    Double: { Type: 'Pass', Transform: 'double', Next: 'Emit' },
    Emit: { Type: 'Succeed', Filter: { Variable: '$', NumericGreaterThan: 6 } },
  },
};

/** Live search: input shaping + switch + timeout + retry + catch. */
export const liveSearch: RslMachine = {
  Comment: 'Wait for typing to settle, skip repeats, cancel stale requests, fall back on error.',
  StartAt: 'Search',
  States: {
    Search: {
      Type: 'Task',
      Resource: 'searchApi',
      Debounce: 300,
      DistinctUntilChanged: true,
      Concurrency: 'switch',
      TimeoutSeconds: 5,
      Retry: [{ ErrorEquals: ['States.Timeout'], MaxAttempts: 2, IntervalSeconds: 1, BackoffRate: 2 }],
      Catch: [{ ErrorEquals: ['States.ALL'], Next: 'Fallback' }],
      End: true,
    },
    Fallback: { Type: 'Pass', Result: { results: [], error: true }, End: true },
  },
};

/** Polling loop: a cycle, natural in ASL topology and awkward in a flat RxJS pipe. */
export const polling: RslMachine = {
  Comment: 'Poll a job until it reports done, then emit { id, job }.',
  StartAt: 'GetStatus',
  States: {
    GetStatus: { Type: 'Task', Resource: 'getJobStatus', InputPath: '$.id', ResultPath: '$.job', Next: 'IsDone' },
    IsDone: {
      Type: 'Choice',
      Choices: [{ Variable: '$.job.status', StringEquals: 'done', Next: 'Finished' }],
      Default: 'Pause',
    },
    Pause: { Type: 'Wait', Seconds: 2, Next: 'GetStatus' },
    Finished: { Type: 'Succeed' },
  },
};

/** Parallel branches with a join policy. Switch Join to combineLatest and the branches may be live streams. */
export const profile: RslMachine = {
  Comment: 'Load a user and their orders side by side, then merge.',
  StartAt: 'LoadProfile',
  States: {
    LoadProfile: {
      Type: 'Parallel',
      Join: 'forkJoin',
      Branches: [
        { StartAt: 'User', States: { User: { Type: 'Task', Resource: 'getUser', End: true } } },
        { StartAt: 'Orders', States: { Orders: { Type: 'Task', Resource: 'getOrders', End: true } } },
      ],
      Next: 'Merge',
    },
    Merge: { Type: 'Pass', Transform: 'toProfile', End: true },
  },
};

/**
 * Checkout: a business flow that exercises Task end to end. Validate each order,
 * charge it one at a time (retrying on timeout with backoff), then notify; any
 * failure ends in Reject with the error beside the order (spec §8).
 */
export const checkout: RslMachine = {
  Comment:
    'Validate each order, charge it one at a time (retrying on timeout with backoff), then notify. Any failure ends in Reject with the error beside the order.',
  StartAt: 'Validate',
  States: {
    Validate: {
      Type: 'Task',
      Resource: 'validate',
      Catch: [{ ErrorEquals: ['ValidationError'], Next: 'Reject', ResultPath: '$.error' }],
      Next: 'Charge',
    },
    Charge: {
      Type: 'Task',
      Resource: 'charge',
      Concurrency: 'concat',
      TimeoutSeconds: 5,
      Retry: [{ ErrorEquals: ['States.Timeout'], IntervalSeconds: 1, MaxAttempts: 3, BackoffRate: 2 }],
      Catch: [{ ErrorEquals: ['States.ALL'], Next: 'Reject', ResultPath: '$.error' }],
      Next: 'Notify',
    },
    Notify: { Type: 'Task', Resource: 'notify', End: true },
    Reject: { Type: 'Task', Resource: 'reject', End: true },
  },
};

export interface Order {
  id: string;
  amount: number;
  email: string;
}

/**
 * The checkout resources. `validate` throws synchronously (the runtime wraps
 * every resource in `defer`, so that is an error notification, not a crash);
 * `charge` answers after a short delay; `notify` and `reject` tag the token.
 */
export const checkoutResources: Record<'validate' | 'charge' | 'notify' | 'reject', ResourceFn> = {
  validate: (input) => {
    const order = input as Order;
    if (!(order.amount > 0)) throw new StateError('ValidationError', `order ${order.id}: amount must be positive`);
    return of({ ...order, valid: true });
  },
  charge: (input) => timer(10).pipe(map(() => ({ ...(input as Order), paymentId: `pay_${(input as Order).id}` }))),
  notify: (input) => of({ ...(input as object), notified: true }),
  reject: (input) => of({ ...(input as object), rejected: true }),
};

export const checkoutRegistry: Registry = { resources: checkoutResources };

/** An example document plus, once the runtime supports its states, an input and registry to run it with. */
export interface Example {
  name: string;
  machine: RslMachine;
  run?: { input: unknown[]; registry: Registry };
}

export const examples: ReadonlyArray<Example> = [
  {
    name: 'map + filter',
    machine: mapFilter,
    run: { input: [1, 2, 3, 4, 5], registry: { transforms: { double: (n) => (n as number) * 2 } } },
  },
  { name: 'Live search', machine: liveSearch },
  { name: 'Polling loop', machine: polling },
  { name: 'Parallel profile', machine: profile },
  {
    name: 'Checkout',
    machine: checkout,
    // One good order and one that fails validation, so the trace shows both paths.
    run: {
      input: [
        { id: 'ord_1', amount: 49, email: 'ada@example.com' },
        { id: 'ord_2', amount: 0, email: 'bob@example.com' },
      ] satisfies Order[],
      registry: checkoutRegistry,
    },
  },
];
