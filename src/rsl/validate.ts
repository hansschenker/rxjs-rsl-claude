import { RslError } from './errors.ts';
import { parsePath } from './paths.ts';
import type { Catcher, Retrier, RslMachine, RslState, Test } from './types.ts';

/**
 * Structural validation (spec §14): the graph rules that `rsl.schema.json`
 * cannot express, checked on a parsed document without a registry.
 *
 * `validate` reports every problem it finds; `assertValid` throws them as one
 * `RslError`. `compile` calls `assertValid` before resolving references, so a
 * document that fails here never reaches the registry.
 */

export interface Issue {
  /** Location in the document, e.g. `States.IsDone.Choices[0].Next`. */
  readonly path: string;
  readonly message: string;
}

const TYPES: ReadonlySet<string> = new Set(['Pass', 'Task', 'Wait', 'Choice', 'Parallel', 'Map', 'Succeed', 'Fail']);
const STATES_ALL = 'States.ALL';
const WAIT_TIMING = ['Seconds', 'Timestamp', 'SecondsPath', 'TimestampPath'] as const;

/** Every structural problem in the document, nested machines included. Empty when the document is valid. */
export function validate(machine: RslMachine): Issue[] {
  const issues: Issue[] = [];
  validateMachine(machine, '', issues);
  return issues;
}

/** Throw one `RslError` listing every issue, or return silently. */
export function assertValid(machine: RslMachine): void {
  const issues = validate(machine);
  if (issues.length === 0) return;
  const lines = issues.map((issue) => `${issue.path}: ${issue.message}`);
  throw new RslError(
    lines.length === 1 ? `Invalid RSL document: ${lines[0]}` : `Invalid RSL document:\n  ${lines.join('\n  ')}`,
  );
}

interface Scope {
  /** Names of the states in the machine being validated; targets must be among them. */
  readonly names: ReadonlySet<string>;
  report(path: string, message: string): void;
  nested(machine: RslMachine, path: string): void;
}

function validateMachine(machine: RslMachine, prefix: string, issues: Issue[]): void {
  const at = (path: string): string => (prefix === '' ? path : `${prefix}.${path}`);
  const report = (path: string, message: string): void => {
    issues.push({ path: at(path), message });
  };

  const states: unknown = machine.States;
  if (states === null || typeof states !== 'object' || Object.keys(states).length === 0) {
    report('States', 'must contain at least one state');
    return;
  }
  if (machine.QueryLanguage !== undefined && machine.QueryLanguage !== 'JSONPath') {
    report('QueryLanguage', `only "JSONPath" is supported in v0, got ${JSON.stringify(machine.QueryLanguage)}`);
  }
  if (machine.OnError !== undefined && machine.OnError !== 'fail' && machine.OnError !== 'drop') {
    report('OnError', `must be "fail" or "drop", got ${JSON.stringify(machine.OnError)}`);
  }

  const names = new Set(Object.keys(machine.States));
  const startExists = names.has(machine.StartAt);
  if (!startExists) report('StartAt', `StartAt ${JSON.stringify(machine.StartAt)} is not a state in States`);

  const scope: Scope = {
    names,
    report,
    nested: (inner, path) => validateMachine(inner, at(path), issues),
  };
  const edges = new Map<string, string[]>();
  for (const [name, state] of Object.entries(machine.States)) {
    edges.set(name, validateState(state, `States.${name}`, scope));
  }

  if (!startExists) return;
  const reachable = new Set([machine.StartAt]);
  const queue = [machine.StartAt];
  for (let i = 0; i < queue.length; i++) {
    for (const target of edges.get(queue[i]) ?? []) {
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }
  for (const name of names) {
    if (!reachable.has(name)) report(`States.${name}`, `not reachable from StartAt ${JSON.stringify(machine.StartAt)}`);
  }
}

/** Validate one state and return the names of the existing states it transitions to. */
function validateState(state: RslState, path: string, scope: Scope): string[] {
  const targets: string[] = [];
  const target = (field: string, name: string | undefined): void => {
    if (name === undefined) return;
    if (scope.names.has(name)) targets.push(name);
    else scope.report(`${path}.${field}`, `target state ${JSON.stringify(name)} does not exist`);
  };

  const type: string = state.Type;
  if (!TYPES.has(type)) {
    scope.report(`${path}.Type`, `unknown state type ${JSON.stringify(type)}`);
    return targets;
  }

  checkPath(state.InputPath, `${path}.InputPath`, scope);
  checkPath(state.OutputPath, `${path}.OutputPath`, scope);
  if (state.Filter !== undefined && typeof state.Filter !== 'string' && typeof state.Filter !== 'function') {
    checkTest(state.Filter, `${path}.Filter`, scope);
  }
  if (typeof state.DistinctUntilChanged === 'string' && state.DistinctUntilChanged.startsWith('$')) {
    checkPath(state.DistinctUntilChanged, `${path}.DistinctUntilChanged`, scope);
  }

  switch (state.Type) {
    case 'Choice':
    case 'Succeed':
    case 'Fail':
      if ('Next' in state || 'End' in state) scope.report(path, `a ${state.Type} state takes neither Next nor End`);
      break;
    default: {
      const hasNext = typeof state.Next === 'string';
      const hasEnd = state.End === true;
      if (hasNext && hasEnd) scope.report(path, 'has both Next and End: true; a state takes exactly one');
      else if (!hasNext && !hasEnd) scope.report(path, 'needs either Next or End: true');
      target('Next', state.Next);
    }
  }

  switch (state.Type) {
    case 'Pass':
      checkPath(state.ResultPath, `${path}.ResultPath`, scope);
      break;
    case 'Task':
      checkPath(state.ResultPath, `${path}.ResultPath`, scope);
      checkRetriers(state.Retry, `${path}.Retry`, scope);
      checkCatchers(state.Catch, `${path}.Catch`, scope, target);
      if (typeof state.Resource === 'object') scope.nested(state.Resource, `${path}.Resource`);
      break;
    case 'Wait': {
      const timing = WAIT_TIMING.filter((field) => state[field] !== undefined);
      if (timing.length !== 1) scope.report(path, `needs exactly one of ${WAIT_TIMING.join(', ')}`);
      checkPath(state.SecondsPath, `${path}.SecondsPath`, scope);
      checkPath(state.TimestampPath, `${path}.TimestampPath`, scope);
      break;
    }
    case 'Choice':
      if (!Array.isArray(state.Choices) || state.Choices.length === 0) {
        scope.report(`${path}.Choices`, 'must contain at least one rule');
      } else {
        state.Choices.forEach((rule, index) => {
          checkTest(rule, `${path}.Choices[${index}]`, scope);
          target(`Choices[${index}].Next`, rule.Next);
        });
      }
      target('Default', state.Default);
      break;
    case 'Parallel':
      if (!Array.isArray(state.Branches) || state.Branches.length === 0) {
        scope.report(`${path}.Branches`, 'must contain at least one branch');
      } else {
        state.Branches.forEach((branch, index) => scope.nested(branch, `${path}.Branches[${index}]`));
      }
      checkPath(state.ResultPath, `${path}.ResultPath`, scope);
      checkRetriers(state.Retry, `${path}.Retry`, scope);
      checkCatchers(state.Catch, `${path}.Catch`, scope, target);
      break;
    case 'Map':
      if (state.ItemProcessor === undefined) scope.report(`${path}.ItemProcessor`, 'is required');
      else scope.nested(state.ItemProcessor, `${path}.ItemProcessor`);
      checkPath(state.ItemsPath, `${path}.ItemsPath`, scope);
      checkPath(state.ResultPath, `${path}.ResultPath`, scope);
      checkRetriers(state.Retry, `${path}.Retry`, scope);
      checkCatchers(state.Catch, `${path}.Catch`, scope, target);
      break;
    case 'Succeed':
    case 'Fail':
      break;
  }

  return targets;
}

function checkRetriers(retriers: Retrier[] | undefined, path: string, scope: Scope): void {
  checkErrorEquals(retriers, path, scope);
}

function checkCatchers(
  catchers: Catcher[] | undefined,
  path: string,
  scope: Scope,
  target: (field: string, name: string | undefined) => void,
): void {
  checkErrorEquals(catchers, path, scope);
  catchers?.forEach((catcher, index) => {
    target(`Catch[${index}].Next`, catcher.Next);
    checkPath(catcher.ResultPath, `${path}[${index}].ResultPath`, scope);
  });
}

/** ASL: `States.ALL` must be the last entry and alone in its `ErrorEquals`. */
function checkErrorEquals(entries: ReadonlyArray<{ ErrorEquals: string[] }> | undefined, path: string, scope: Scope): void {
  if (entries === undefined) return;
  entries.forEach((entry, index) => {
    const where = `${path}[${index}].ErrorEquals`;
    if (!Array.isArray(entry.ErrorEquals) || entry.ErrorEquals.length === 0) {
      scope.report(where, 'must list at least one error name');
      return;
    }
    if (!entry.ErrorEquals.includes(STATES_ALL)) return;
    if (entry.ErrorEquals.length > 1) scope.report(where, `${STATES_ALL} must be alone in its ErrorEquals`);
    if (index !== entries.length - 1) scope.report(where, `${STATES_ALL} must be in the last entry`);
  });
}

function checkTest(test: Test, path: string, scope: Scope): void {
  if ('And' in test) {
    test.And.forEach((part, index) => checkTest(part, `${path}.And[${index}]`, scope));
  } else if ('Or' in test) {
    test.Or.forEach((part, index) => checkTest(part, `${path}.Or[${index}]`, scope));
  } else if ('Not' in test) {
    checkTest(test.Not, `${path}.Not`, scope);
  } else if ('Condition' in test) {
    // A registry name or a function; `compile` resolves it.
  } else if (test.Variable === undefined) {
    scope.report(path, 'must be a data test (Variable + comparison), a Condition, or And / Or / Not');
  } else {
    checkPath(test.Variable, `${path}.Variable`, scope);
  }
}

function checkPath(path: string | undefined, where: string, scope: Scope): void {
  if (path === undefined) return;
  try {
    parsePath(path);
  } catch (error) {
    scope.report(where, error instanceof Error ? error.message : String(error));
  }
}
