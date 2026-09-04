import { describe, expect, it } from 'vitest';
import * as examples from './examples.ts';
import * as rsl from './index.ts';

describe('package entries', () => {
  it('the main entry exports the public API', () => {
    expect(typeof rsl.compile).toBe('function');
    expect(typeof rsl.validate).toBe('function');
    expect(typeof rsl.assertValid).toBe('function');
    expect(typeof rsl.toMermaid).toBe('function');
    expect(typeof rsl.toPipeView).toBe('function');
    expect(typeof rsl.stateOps).toBe('function');
    expect(typeof rsl.traceLine).toBe('function');
    expect(typeof rsl.traceToJson).toBe('function');
    expect(typeof rsl.errorName).toBe('function');
    expect(typeof rsl.defineMachine).toBe('function');
    expect(typeof rsl.parseDocument).toBe('function');
    expect(typeof rsl.getPath).toBe('function');
    expect(typeof rsl.setPath).toBe('function');
    expect(typeof rsl.parsePath).toBe('function');
    expect(rsl.OUTPUT).toBe('$output');
    expect(new rsl.RslError('x')).toBeInstanceOf(Error);
    expect(new rsl.StateError('States.Fail')).toBeInstanceOf(Error);
  });

  it('keeps the examples on their own entry', () => {
    expect('examples' in rsl).toBe(false);
    expect(examples.examples.map((example) => example.name)).toEqual([
      'map + filter',
      'Live search',
      'Polling loop',
      'Parallel profile',
      'Checkout',
    ]);
  });
});
