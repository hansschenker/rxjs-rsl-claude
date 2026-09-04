import { from, lastValueFrom, toArray } from 'rxjs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { compile } from './compile.ts';
import { checkout, mapFilter, profile } from './examples.ts';
import { defineMachine } from './registry.ts';
import type { KeyNames, PredicateNames, RegistryFor, ResourceNames, TransformNames } from './registry.ts';
import type { RslMachine } from './types.ts';

/**
 * The typed registry (spec §6). `expectTypeOf` and `@ts-expect-error` make
 * these assertions at type-check time, which `npm run build` runs over the
 * tests; the runtime assertions show the same document really runs.
 */

const doc = defineMachine({
  StartAt: 'Double',
  States: {
    Double: { Type: 'Pass', Transform: 'double', Next: 'Emit' },
    Emit: {
      Type: 'Succeed',
      Filter: { And: [{ Condition: 'positive' }, { Not: { Condition: 'huge' } }] },
      DistinctUntilChanged: 'byValue',
    },
  },
});

const registry = {
  transforms: { double: (n: number) => n * 2 },
  predicates: { positive: (n: number) => n > 0, huge: (n: number) => n > 1e6 },
  keys: { byValue: (n: number) => n },
} satisfies RegistryFor<typeof doc>;

describe('typed registry: the names a document references', () => {
  it('are read from the document type, nested machines included', () => {
    expectTypeOf<TransformNames<typeof mapFilter>>().toEqualTypeOf<'double'>();
    expectTypeOf<PredicateNames<typeof mapFilter>>().toEqualTypeOf<never>();
    expectTypeOf<ResourceNames<typeof checkout>>().toEqualTypeOf<'validate' | 'charge' | 'notify' | 'reject'>();
    expectTypeOf<ResourceNames<typeof profile>>().toEqualTypeOf<'getUser' | 'getOrders'>();
    expectTypeOf<TransformNames<typeof profile>>().toEqualTypeOf<'toProfile'>();
    expectTypeOf<PredicateNames<typeof doc>>().toEqualTypeOf<'positive' | 'huge'>();
    expectTypeOf<KeyNames<typeof doc>>().toEqualTypeOf<'byValue'>();
  });

  it('are just string for a document typed as RslMachine, so nothing is checked', () => {
    expectTypeOf<ResourceNames<RslMachine>>().toEqualTypeOf<string>();
    expectTypeOf<PredicateNames<RslMachine>>().toEqualTypeOf<string>();
    const plain: RslMachine = mapFilter;
    // Type-checks (the registry is optional and untyped), and fails at run time as before.
    expect(() => compile(plain)).toThrow('no transform named "double"');
    expect(() => compile(plain, {})).toThrow('no transform named "double"');
  });

  it('treat a $-path in DistinctUntilChanged as a path, not a key name', () => {
    const byPath = defineMachine({ StartAt: 'A', States: { A: { Type: 'Succeed', DistinctUntilChanged: '$.id' } } });
    expectTypeOf<KeyNames<typeof byPath>>().toEqualTypeOf<never>();
    expect(() => compile(byPath)).not.toThrow();
  });
});

describe('typed registry: compile', () => {
  it('accepts a registry with every referenced name, and runs it', async () => {
    const out = await lastValueFrom(from([1, 1, -2, 3]).pipe(compile<number, number>(doc, registry), toArray()));
    expect(out).toEqual([2, 6]);
    compile(doc, { ...registry, resources: { anything: (id: string) => [id] } });
  });

  it('rejects a missing registry, a missing name, and a name in the wrong bucket', () => {
    // These calls exist for the type checker; they are never run.
    const typeChecks = (): void => {
      // @ts-expect-error the document references names, so the registry is required
      compile(doc);
      // @ts-expect-error the predicate "huge" is missing
      compile(doc, { ...registry, predicates: { positive: registry.predicates.positive } });
      // @ts-expect-error "byValue" is a key, not a predicate
      compile(doc, { transforms: registry.transforms, predicates: { ...registry.predicates, byValue: () => true } });
      // @ts-expect-error a plain function is not a registry
      compile(doc, (n: number) => n);
    };
    expect(typeChecks).toBeTypeOf('function');
  });

  it('checks nested machines through Parallel branches', () => {
    // Parallel is not implemented yet, so these calls exist for the type checker only.
    const typeChecks = (): void => {
      compile(profile, {
        resources: { getUser: (id: string) => [{ id }], getOrders: (id: string) => [{ id, orders: [] }] },
        transforms: { toProfile: (parts: unknown[]) => parts },
      });
      // @ts-expect-error "getOrders" lives in the second branch and is missing
      compile(profile, { resources: { getUser: (id: string) => [{ id }] }, transforms: { toProfile: (x: unknown) => x } });
    };
    expect(typeChecks).toBeTypeOf('function');
  });
});

describe('defineMachine', () => {
  it('returns the document unchanged', () => {
    expect(defineMachine(mapFilter)).toBe(mapFilter);
  });
});
