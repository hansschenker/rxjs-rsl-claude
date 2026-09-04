import { TestScheduler } from 'rxjs/testing';
import { describe, expect, it } from 'vitest';
import { compile } from './compile.ts';
import { examples } from './examples.ts';
import type { Example } from './examples.ts';
import { StateError } from './errors.ts';
import { OUTPUT, traceLine } from './trace.ts';
import type { TraceEvent } from './trace.ts';

/**
 * Golden traces: every runnable example is run under virtual time and its
 * events are compared with `src/rsl/traces/<name>.trace.json`. A change in
 * the trace shape or in what the runtime reports shows up as a diff there;
 * `npx vitest run -u` accepts an intentional one.
 */

type Runnable = Example & { run: NonNullable<Example['run']> };
const runnable = examples.filter((example): example is Runnable => example.run !== undefined);

const letter = (index: number): string => String.fromCharCode(97 + index);

/** Emit the inputs one frame apart, then complete: `a-b-c|`. */
function marble(count: number): string {
  return Array.from({ length: count }, (_, i) => letter(i)).join('-') + '|';
}

function values(input: unknown[]): Record<string, unknown> {
  return Object.fromEntries(input.map((value, i) => [letter(i), value]));
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Errors have no enumerable fields; keep their name and message in the golden file. */
function serialize(events: TraceEvent[]): string {
  const replacer = (_key: string, value: unknown): unknown =>
    value instanceof Error ? { name: value.name, message: value.message } : value;
  return JSON.stringify(events, replacer, 2) + '\n';
}

function record(example: Runnable): TraceEvent[] {
  const events: TraceEvent[] = [];
  const scheduler = new TestScheduler((actual, expected) => expect(actual).toEqual(expected));
  scheduler.run(({ cold }) => {
    const source = cold(marble(example.run.input.length), values(example.run.input));
    source.pipe(compile(example.machine, example.run.registry, { trace: (event) => void events.push(event) })).subscribe();
  });
  return events;
}

describe('golden traces', () => {
  it('covers at least the map + filter example', () => {
    expect(runnable.map((example) => example.name)).toContain('map + filter');
  });

  it.each(runnable)('$name matches its file under src/rsl/traces', async ({ name, machine, run }) => {
    await expect(serialize(record({ name, machine, run }))).toMatchFileSnapshot(`./traces/${slug(name)}.trace.json`);
  });

  it.each(runnable)('$name events are in time order, in the root run, and end at the output', ({ name, machine, run }) => {
    const events = record({ name, machine, run });
    expect(events.length).toBeGreaterThan(0);
    for (const [i, event] of events.entries()) {
      expect(event.run).toBe('');
      if (i > 0) expect(event.at).toBeGreaterThanOrEqual(events[i - 1]!.at);
    }
    const exits = events.filter((event) => event.kind === 'out' && event.target === OUTPUT);
    expect(exits.length).toBeGreaterThan(0);
  });
});

describe('traceLine', () => {
  const base = { run: '', state: 'Search', tokenId: 3, value: 'rx', at: 300 } as const;

  it('renders each kind with its detail', () => {
    expect(traceLine({ ...base, kind: 'in' })).toMatch(/^in\s+Search\s+#3 "rx"$/);
    expect(traceLine({ ...base, kind: 'out', target: 'Fallback' })).toMatch(/^out\s+Search\s+#3 "rx" → Fallback$/);
    expect(traceLine({ ...base, kind: 'drop', policy: 'Debounce' })).toMatch(/#3 "rx" \(Debounce\)$/);
    expect(traceLine({ ...base, kind: 'cancel', reason: 'switch' })).toMatch(/^cancel\s+Search\s+#3 "rx" \(switch\)$/);
    expect(traceLine({ ...base, kind: 'retry', attempt: 2, error: new StateError('States.Timeout') })).toMatch(
      /retry 2: States\.Timeout$/,
    );
    expect(traceLine({ ...base, kind: 'catch', error: new StateError('States.Timeout'), target: 'Fallback' })).toMatch(
      /States\.Timeout → Fallback$/,
    );
    expect(traceLine({ ...base, kind: 'error', error: 'boom', onError: 'drop' })).toMatch(/boom → drop$/);
  });

  it('prefixes the state with the run of a nested machine', () => {
    const nested = { ...base, run: 'States.LoadProfile.Branches[0]#3', state: 'User', kind: 'in' } as const;
    expect(traceLine(nested)).toContain('States.LoadProfile.Branches[0]#3 User');
  });
});
