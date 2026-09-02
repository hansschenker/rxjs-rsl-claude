import { describe, expect, it } from 'vitest';
import { RslError } from './errors.ts';
import { getPath, setPath } from './paths.ts';

describe('paths', () => {
  it('reads $, dotted, and indexed paths, and yields undefined for missing ones', () => {
    const value = { a: { b: [10, { c: 'x' }] } };
    expect(getPath(value, '$')).toBe(value);
    expect(getPath(value, '$.a.b[0]')).toBe(10);
    expect(getPath(value, '$.a.b[1].c')).toBe('x');
    expect(getPath(value, '$.missing.deeper')).toBeUndefined();
    expect(getPath(7, '$.x')).toBeUndefined();
  });

  it('writes immutably and creates intermediate objects', () => {
    const value = { id: 1 };
    const out = setPath(value, '$.job', { status: 'done' });
    expect(out).toEqual({ id: 1, job: { status: 'done' } });
    expect(value).toEqual({ id: 1 });
    expect(setPath(value, '$', 5)).toBe(5);
    expect(setPath(undefined, '$.a.b[1]', 'x')).toEqual({ a: { b: [undefined, 'x'] } });
  });

  it('rejects unsupported syntax and non-object intermediates', () => {
    expect(() => getPath({}, 'a.b')).toThrow(RslError);
    expect(() => getPath({}, '$[*]')).toThrow(RslError);
    expect(() => setPath({ a: 1 }, '$.a.b', 2)).toThrow(RslError);
  });
});
