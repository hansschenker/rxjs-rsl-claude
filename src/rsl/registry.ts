import type { KeyFn, PredicateFn, ResourceFn, RslMachine, Test, TransformFn } from './types.ts';

/**
 * Typed registries (spec §6). The names a document references are computed
 * from its type, so `compile(machine, registry)` fails to type-check when a
 * resource, transform, predicate or key is missing or sits in the wrong
 * bucket. This needs a document with literal types: write it with
 * `defineMachine` (or `as const`). A document typed as plain `RslMachine`
 * has no literal names; every bucket is then optional and untyped.
 *
 * Every walk below short-circuits to `string` on a widened type. That is not
 * only what "no literal names" means, it is also what keeps the compiler from
 * recursing through `RslMachine` and `Test`, both of which refer to themselves.
 */

/** Keep the literal types of a document so its registry can be typed. Returns the argument unchanged. */
export function defineMachine<const M extends RslMachine>(machine: M): M {
  return machine;
}

type StatesOf<M> = M extends { readonly States: infer S } ? S[keyof S] : never;
type Str<T> = T extends string ? T : never;

/** A widened document has `StartAt: string`; a literal one has a literal. */
type Widened<M> = string extends (M extends { readonly StartAt: infer S } ? S : never) ? true : false;

/** The machines nested in a state: Parallel branches, a Map item processor, a Task whose Resource is a machine. */
type Nested<S> =
  | (S extends { readonly Branches: readonly (infer B)[] } ? B : never)
  | (S extends { readonly ItemProcessor: infer P } ? P : never)
  | (S extends { readonly Resource: infer R } ? (R extends RslMachine ? R : never) : never);

/** Predicate names inside a test. The first clause stops on the widened `Test`, which refers to itself through And, Or and Not. */
type TestNames<T> = Test extends T
  ? string
  : T extends { readonly Condition: infer C }
    ? Str<C>
    : T extends { readonly And: readonly (infer P)[] }
      ? TestNames<P>
      : T extends { readonly Or: readonly (infer P)[] }
        ? TestNames<P>
        : T extends { readonly Not: infer P }
          ? TestNames<P>
          : never;

type OwnResources<S> = S extends { readonly Resource: infer R } ? Str<R> : never;
type OwnTransforms<S> = S extends { readonly Transform: infer T } ? Str<T> : never;
type OwnPredicates<S> =
  | (S extends { readonly Filter: infer F } ? (F extends string ? F : TestNames<F>) : never)
  | (S extends { readonly Choices: readonly (infer R)[] } ? TestNames<R> : never);
/** A `DistinctUntilChanged` string is a key name unless it starts with `$`, which makes it a path. */
type OwnKeys<S> = S extends { readonly DistinctUntilChanged: infer D } ? (D extends `$${string}` ? never : Str<D>) : never;

type Bucket = 'resources' | 'transforms' | 'predicates' | 'keys';

type OwnNames<S, B extends Bucket> = B extends 'resources'
  ? OwnResources<S>
  : B extends 'transforms'
    ? OwnTransforms<S>
    : B extends 'predicates'
      ? OwnPredicates<S>
      : OwnKeys<S>;

/** The names in bucket `B` that `M` and its nested machines reference; `string` when `M` is widened. */
type Names<M, B extends Bucket> = Widened<M> extends true
  ? string
  : OwnNames<StatesOf<M>, B> | ([Nested<StatesOf<M>>] extends [never] ? never : Names<Nested<StatesOf<M>>, B>);

export type ResourceNames<M> = Names<M, 'resources'>;
export type TransformNames<M> = Names<M, 'transforms'>;
export type PredicateNames<M> = Names<M, 'predicates'>;
export type KeyNames<M> = Names<M, 'keys'>;

/** `true` when the names are a non-empty union of literals: the bucket can be checked. */
type Literal<N> = [N] extends [never] ? false : string extends N ? false : true;

interface Fns {
  resources: ResourceFn | RslMachine;
  transforms: TransformFn;
  predicates: PredicateFn;
  keys: KeyFn;
}

type NamesIn<M, B extends Bucket> = B extends 'resources'
  ? ResourceNames<M>
  : B extends 'transforms'
    ? TransformNames<M>
    : B extends 'predicates'
      ? PredicateNames<M>
      : KeyNames<M>;

/** Every referenced name, plus any extras (a registry may serve several documents). */
type Checked<N, F> = { readonly [name in N & string]: F } & { readonly [name: string]: F };
type Loose<F> = { readonly [name: string]: F };

/**
 * The registry a document needs. A bucket is required and name-checked when
 * the document references literal names in it, optional and untyped otherwise.
 * For a plain `RslMachine` this is the same shape as `Registry`.
 */
export type RegistryFor<M extends RslMachine> = {
  readonly [B in Bucket as Literal<NamesIn<M, B>> extends true ? B : never]: Checked<NamesIn<M, B>, Fns[B]>;
} & {
  readonly [B in Bucket as Literal<NamesIn<M, B>> extends true ? never : B]?: Loose<Fns[B]>;
};

type RequiresRegistry<M> = Literal<ResourceNames<M>> extends true
  ? true
  : Literal<TransformNames<M>> extends true
    ? true
    : Literal<PredicateNames<M>> extends true
      ? true
      : Literal<KeyNames<M>>;

/** The arguments after the document: the registry is required exactly when the document references names. */
export type CompileArgs<M extends RslMachine, Options> = RequiresRegistry<M> extends true
  ? [registry: RegistryFor<M>, options?: Options]
  : [registry?: RegistryFor<M>, options?: Options];
