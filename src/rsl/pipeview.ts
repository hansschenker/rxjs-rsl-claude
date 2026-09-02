import { flattenName, refName, testLabel } from './labels.ts';
import type { RslMachine, RslState, Transition } from './types.ts';

/**
 * Render an RSL document as one line per state showing the RxJS operators the
 * state stands for. The diagram says where values go; this says what they pass through.
 */
export function toPipeView(machine: RslMachine): string {
  const lines = [`source → ${machine.StartAt}`];
  for (const [name, state] of Object.entries(machine.States)) {
    lines.push(`${name}: ${stateOps(state).join(' → ')}`);
  }
  return lines.join('\n');
}

/** The operator chain for a single state: shaping first, then the state's work, then its target. */
export function stateOps(state: RslState): string[] {
  const ops = shapingOps(state);
  switch (state.Type) {
    case 'Pass':
      if (state.Transform !== undefined) ops.push(`map(${refName(state.Transform)})`);
      else if (state.Result !== undefined) ops.push(`map(() => ${JSON.stringify(state.Result)})`);
      else ops.push('map(identity)');
      ops.push(target(state));
      break;
    case 'Task': {
      const max = state.MaxConcurrency ? `, ${state.MaxConcurrency}` : '';
      ops.push(`${flattenName(state.Concurrency)}(${refName(state.Resource)}${max})`);
      if (state.TimeoutSeconds !== undefined) ops.push(`timeout({ first: ${state.TimeoutSeconds * 1000} })`);
      for (const retrier of state.Retry ?? []) {
        ops.push(`retry(${retrier.MaxAttempts ?? 3} on ${retrier.ErrorEquals.join(', ')})`);
      }
      if (state.Take !== undefined) ops.push(`take(${state.Take})`);
      for (const catcher of state.Catch ?? []) ops.push(`catchError(→ ${catcher.Next})`);
      ops.push(target(state));
      break;
    }
    case 'Wait':
      ops.push(waitOp(state));
      ops.push(target(state));
      break;
    case 'Choice': {
      const routes = state.Choices.map((rule) => `${testLabel(rule)} → ${rule.Next}`);
      if (state.Default) routes.push(`default → ${state.Default}`);
      ops.push(`route(${routes.join(', ')})`);
      break;
    }
    case 'Parallel': {
      const branches = state.Branches.map((branch) => branch.StartAt).join(', ');
      ops.push(`${flattenName(state.Concurrency)}(${state.Join ?? 'forkJoin'}(${branches}))`);
      for (const catcher of state.Catch ?? []) ops.push(`catchError(→ ${catcher.Next})`);
      ops.push(target(state));
      break;
    }
    case 'Map': {
      const max = state.MaxConcurrency ? String(state.MaxConcurrency) : '∞';
      const collect = state.Collect === 'stream' ? 'each' : 'toArray()';
      const items = state.ItemsPath ?? '$';
      ops.push(
        `${flattenName(state.Concurrency)}(from(${items}) → mergeMap(${state.ItemProcessor.StartAt}, ${max}) → ${collect})`,
      );
      for (const catcher of state.Catch ?? []) ops.push(`catchError(→ ${catcher.Next})`);
      ops.push(target(state));
      break;
    }
    case 'Succeed':
      ops.push('output');
      break;
    case 'Fail':
      ops.push(`throwError(${state.Error ?? 'States.Fail'})`);
      break;
  }
  return ops;
}

function shapingOps(state: RslState): string[] {
  const ops: string[] = [];
  if (state.Filter !== undefined) ops.push(`filter(${testLabel(state.Filter)})`);
  if (state.Debounce !== undefined) ops.push(`debounceTime(${state.Debounce})`);
  if (state.Throttle !== undefined) ops.push(`throttleTime(${state.Throttle})`);
  if (state.DistinctUntilChanged !== undefined) {
    const key = state.DistinctUntilChanged === true ? '' : refName(state.DistinctUntilChanged);
    ops.push(`distinctUntilChanged(${key})`);
  }
  return ops;
}

function waitOp(state: Extract<RslState, { Type: 'Wait' }>): string {
  if (state.Seconds !== undefined) return `delay(${state.Seconds * 1000})`;
  if (state.Timestamp !== undefined) return `delay(until ${state.Timestamp})`;
  if (state.SecondsPath !== undefined) return `delay(${state.SecondsPath} s)`;
  return `delay(until ${state.TimestampPath})`;
}

function target(state: Transition): string {
  return state.Next ?? 'output';
}
