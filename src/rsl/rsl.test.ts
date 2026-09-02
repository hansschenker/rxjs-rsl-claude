import { describe, expect, it } from 'vitest';
import { toMermaid } from './diagram.ts';
import { examples, liveSearch, mapFilter, polling, profile } from './examples.ts';
import { toPipeView } from './pipeview.ts';
import type { RslMachine, RslState } from './types.ts';

function targets(state: RslState): string[] {
  const out: string[] = [];
  if ('Next' in state && state.Next) out.push(state.Next);
  if (state.Type === 'Choice') {
    out.push(...state.Choices.map((rule) => rule.Next));
    if (state.Default) out.push(state.Default);
  }
  if ('Catch' in state && state.Catch) out.push(...state.Catch.map((catcher) => catcher.Next));
  return out;
}

function expectWellFormed(machine: RslMachine): void {
  expect(machine.States).toHaveProperty(machine.StartAt);
  for (const state of Object.values(machine.States)) {
    for (const name of targets(state)) expect(machine.States, `missing target ${name}`).toHaveProperty(name);
    if (state.Type === 'Parallel') state.Branches.forEach(expectWellFormed);
    if (state.Type === 'Map') expectWellFormed(state.ItemProcessor);
  }
}

describe('examples', () => {
  it.each(examples)('$name references only existing states', ({ machine }) => {
    expectWellFormed(machine);
  });
});

describe('toPipeView', () => {
  it('renders map + filter as two states', () => {
    const view = toPipeView(mapFilter);
    expect(view).toContain('source → Double');
    expect(view).toContain('Double: map(double) → Emit');
    expect(view).toContain('Emit: filter($ > 6) → output');
  });

  it('renders the live search pipe with shaping and execution policies', () => {
    const view = toPipeView(liveSearch);
    expect(view).toContain('debounceTime(300)');
    expect(view).toContain('distinctUntilChanged()');
    expect(view).toContain('switchMap(searchApi)');
    expect(view).toContain('timeout({ first: 5000 })');
    expect(view).toContain('retry(2 on States.Timeout)');
    expect(view).toContain('catchError(→ Fallback)');
  });

  it('renders Choice as a route and Wait as a delay', () => {
    const view = toPipeView(polling);
    expect(view).toContain('IsDone: route($.job.status == "done" → Finished, default → Pause)');
    expect(view).toContain('Pause: delay(2000) → GetStatus');
  });
});

describe('toMermaid', () => {
  it('wires the machine between in and out', () => {
    const src = toMermaid(mapFilter);
    expect(src).toMatch(/^flowchart TD/);
    expect(src).toContain('rsl_in --> m_Double');
    expect(src).toContain('m_Double --> m_Emit');
    expect(src).toContain('m_Emit --> rsl_out');
  });

  it('draws the polling loop as a back edge and Choice as a diamond', () => {
    const src = toMermaid(polling);
    expect(src).toContain('m_Pause --> m_GetStatus');
    expect(src).toContain('m_IsDone{"');
    expect(src).toContain('-->|"$.job.status == #quot;done#quot;"| m_Finished');
  });

  it('draws parallel branches as subgraphs with a join node', () => {
    const src = toMermaid(profile);
    expect(src.match(/subgraph /g)).toHaveLength(2);
    expect(src).toContain('m_LoadProfile --> m_LoadProfile_b0_User');
    expect(src).toContain('m_LoadProfile_b1_Orders --> m_LoadProfile_join');
    expect(src).toContain('join: forkJoin');
  });

  it('draws Catch as a dashed edge and escapes comparison operators', () => {
    expect(toMermaid(liveSearch)).toContain('-.->|"States.ALL"| m_Fallback');
    expect(toMermaid(mapFilter)).toContain('filter: $ #62; 6');
  });
});
