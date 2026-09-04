import { RslError } from './errors.ts';
import type { RslMachine } from './types.ts';
import { assertValid } from './validate.ts';

/**
 * Read a document from its JSON text: parse it and check the graph rules of
 * spec §14, so the result is a structurally valid `RslMachine`. The JSON
 * Schema (shape) is not applied here; `rsl validate` does that with Ajv.
 */
export function parseDocument(text: string): RslMachine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RslError(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RslError('An RSL document is a JSON object with StartAt and States');
  }
  const machine = parsed as RslMachine;
  assertValid(machine);
  return machine;
}
