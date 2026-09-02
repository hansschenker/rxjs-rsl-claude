import { flattenName, refName, testLabel } from './labels.ts';
import type { RslMachine, RslState } from './types.ts';

export interface MermaidOptions {
  /** Flowchart direction. */
  direction?: 'TD' | 'LR';
}

interface Emitter {
  lines: string[];
}

interface Wiring {
  entry: string;
  exits: string[];
}

const IN = 'rsl_in';
const OUT = 'rsl_out';
const FAIL_STYLE = 'stroke:#c2185b,stroke-width:2px';

/**
 * Render an RSL document as Mermaid `flowchart` text. Pure string building,
 * so it runs without a DOM; hand the result to `mermaid.render` to get SVG.
 */
export function toMermaid(machine: RslMachine, options: MermaidOptions = {}): string {
  const em: Emitter = { lines: [`flowchart ${options.direction ?? 'TD'}`] };
  em.lines.push(`  ${IN}((in))`);
  const { entry, exits } = emitMachine(machine, 'm', em);
  em.lines.push(`  ${OUT}((out))`);
  em.lines.push(`  ${IN} --> ${entry}`);
  for (const exit of exits) em.lines.push(`  ${exit} --> ${OUT}`);
  return em.lines.join('\n');
}

function emitMachine(machine: RslMachine, prefix: string, em: Emitter): Wiring {
  const id = (name: string): string => `${prefix}_${sanitize(name)}`;
  const exits: string[] = [];

  for (const [name, state] of Object.entries(machine.States)) {
    const nodeId = id(name);
    em.lines.push(`  ${node(nodeId, name, state)}`);

    switch (state.Type) {
      case 'Choice':
        for (const rule of state.Choices) em.lines.push(`  ${nodeId} -->|"${esc(testLabel(rule))}"| ${id(rule.Next)}`);
        if (state.Default) em.lines.push(`  ${nodeId} -->|"default"| ${id(state.Default)}`);
        break;
      case 'Succeed':
        exits.push(nodeId);
        break;
      case 'Fail':
        em.lines.push(`  style ${nodeId} ${FAIL_STYLE}`);
        break;
      case 'Parallel': {
        const joinId = `${nodeId}_join`;
        state.Branches.forEach((branch, i) => {
          const sub = `${nodeId}_b${i}`;
          em.lines.push(`  subgraph ${sub} ["branch ${i + 1}"]`);
          const wiring = emitMachine(branch, sub, em);
          em.lines.push('  end');
          em.lines.push(`  ${nodeId} --> ${wiring.entry}`);
          for (const exit of wiring.exits) em.lines.push(`  ${exit} --> ${joinId}`);
        });
        em.lines.push(`  ${joinId}(("join: ${state.Join ?? 'forkJoin'}"))`);
        transition(joinId, state.Next, id, exits, em);
        break;
      }
      case 'Map': {
        const joinId = `${nodeId}_join`;
        const sub = `${nodeId}_item`;
        em.lines.push(`  subgraph ${sub} ["each item"]`);
        const wiring = emitMachine(state.ItemProcessor, sub, em);
        em.lines.push('  end');
        em.lines.push(`  ${nodeId} --> ${wiring.entry}`);
        for (const exit of wiring.exits) em.lines.push(`  ${exit} --> ${joinId}`);
        em.lines.push(`  ${joinId}(("collect: ${state.Collect ?? 'array'}"))`);
        transition(joinId, state.Next, id, exits, em);
        break;
      }
      default:
        transition(nodeId, state.Next, id, exits, em);
    }

    if ('Catch' in state && state.Catch) {
      for (const catcher of state.Catch) {
        em.lines.push(`  ${nodeId} -.->|"${esc(catcher.ErrorEquals.join(', '))}"| ${id(catcher.Next)}`);
      }
    }
  }

  return { entry: id(machine.StartAt), exits };
}

function transition(
  from: string,
  next: string | undefined,
  id: (name: string) => string,
  exits: string[],
  em: Emitter,
): void {
  if (next) em.lines.push(`  ${from} --> ${id(next)}`);
  else exits.push(from);
}

function node(id: string, name: string, state: RslState): string {
  const label = nodeLabel(name, state);
  switch (state.Type) {
    case 'Task':
      return `${id}["${label}"]`;
    case 'Pass':
      return `${id}("${label}")`;
    case 'Choice':
      return `${id}{"${label}"}`;
    case 'Wait':
      return `${id}{{"${label}"}}`;
    case 'Parallel':
    case 'Map':
      return `${id}[["${label}"]]`;
    case 'Succeed':
    case 'Fail':
      return `${id}((("${label}")))`;
  }
}

function nodeLabel(name: string, state: RslState): string {
  const lines = [`<b>${esc(name)}</b>`, esc(typeLine(state))];
  const badges = policyBadges(state);
  if (badges.length > 0) lines.push(esc(badges.join(' · ')));
  return lines.join('<br/>');
}

function typeLine(state: RslState): string {
  switch (state.Type) {
    case 'Task':
      return `Task · ${refName(state.Resource)}`;
    case 'Pass':
      if (state.Transform !== undefined) return `Pass · map(${refName(state.Transform)})`;
      if (state.Result !== undefined) return `Pass · ${JSON.stringify(state.Result)}`;
      return 'Pass';
    case 'Wait':
      if (state.Seconds !== undefined) return `Wait · ${state.Seconds}s`;
      if (state.Timestamp !== undefined) return `Wait · until ${state.Timestamp}`;
      if (state.SecondsPath !== undefined) return `Wait · ${state.SecondsPath} s`;
      return `Wait · until ${state.TimestampPath}`;
    case 'Choice':
      return 'Choice';
    case 'Parallel':
      return 'Parallel';
    case 'Map':
      return `Map · ${state.ItemsPath ?? '$'}`;
    case 'Succeed':
      return 'Succeed';
    case 'Fail':
      return state.Error ? `Fail · ${state.Error}` : 'Fail';
  }
}

function policyBadges(state: RslState): string[] {
  const badges: string[] = [];
  if (state.Filter !== undefined) badges.push(`filter: ${testLabel(state.Filter)}`);
  if (state.Debounce !== undefined) badges.push(`debounce ${state.Debounce}`);
  if (state.Throttle !== undefined) badges.push(`throttle ${state.Throttle}`);
  if (state.DistinctUntilChanged !== undefined) {
    const key = state.DistinctUntilChanged === true ? '' : `(${refName(state.DistinctUntilChanged)})`;
    badges.push(`distinctUntilChanged${key}`);
  }
  if ('Concurrency' in state && state.Concurrency) badges.push(flattenName(state.Concurrency));
  if ('MaxConcurrency' in state && state.MaxConcurrency) badges.push(`max ${state.MaxConcurrency}`);
  if (state.Type === 'Task') {
    if (state.TimeoutSeconds !== undefined) badges.push(`timeout ${state.TimeoutSeconds}s`);
    if (state.Take !== undefined) badges.push(`take ${state.Take}`);
  }
  if ('Retry' in state && state.Retry) {
    for (const retrier of state.Retry) {
      badges.push(`retry ×${retrier.MaxAttempts ?? 3} on ${retrier.ErrorEquals.join(', ')}`);
    }
  }
  return badges;
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

/** Mermaid entity escapes for text inside a quoted label. */
function esc(text: string): string {
  return text.replace(/&/g, '#38;').replace(/"/g, '#quot;').replace(/</g, '#60;').replace(/>/g, '#62;');
}
