import { RslError } from './errors.ts';

/**
 * The JSONPath subset RSL supports: `$`, `$.a.b`, `$.a[0]`, and combinations.
 * Reads of missing paths yield `undefined`; writes copy along the path.
 */

type Segment = string | number;

export function parsePath(path: string): Segment[] {
  if (!path.startsWith('$')) throw new RslError(`Invalid path "${path}": must start with $`);
  const segment = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/y;
  const segments: Segment[] = [];
  segment.lastIndex = 1;
  while (segment.lastIndex < path.length) {
    const match = segment.exec(path);
    if (match === null) throw new RslError(`Invalid path "${path}": only $, $.a.b and $.a[0] are supported`);
    segments.push(match[1] !== undefined ? match[1] : Number(match[2]));
  }
  return segments;
}

export function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of parsePath(path)) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === 'number') {
      current = Array.isArray(current) ? current[segment] : undefined;
    } else {
      current = typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined;
    }
  }
  return current;
}

/** Returns a copy of `value` with `result` inserted at `path`. `$` replaces the value entirely. */
export function setPath(value: unknown, path: string, result: unknown): unknown {
  return assign(value, parsePath(path), 0, result, path);
}

function assign(current: unknown, segments: Segment[], index: number, result: unknown, path: string): unknown {
  if (index === segments.length) return result;
  const segment = segments[index];
  if (typeof segment === 'number') {
    const copy: unknown[] = Array.isArray(current) ? [...(current as unknown[])] : [];
    copy[segment] = assign(copy[segment], segments, index + 1, result, path);
    return copy;
  }
  if (current === undefined || current === null) {
    return { [segment]: assign(undefined, segments, index + 1, result, path) };
  }
  if (typeof current === 'object' && !Array.isArray(current)) {
    const record = current as Record<string, unknown>;
    return { ...record, [segment]: assign(record[segment], segments, index + 1, result, path) };
  }
  throw new RslError(`Cannot set ${path}: the value at ".${segment}" is not an object`);
}
