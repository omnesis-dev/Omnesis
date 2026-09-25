// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The nominal-typing primitive shared by every branded type in the
 * workspace (branded IDs in `ids.ts`, device/token IDs in `device.ts`,
 * the WS correlation ID in `@omnesis/core`).
 *
 * `Brand<T, B>` intersects a structural carrier `T` (always a primitive
 * like `string`) with a phantom property keyed by the module-private
 * `brand` symbol and tagged with the literal `B`. The phantom property
 * exists only at the type level — `brand` is `declare const` (ambient,
 * never emitted), so a branded value is byte-identical to its carrier at
 * runtime. The compiler, however, treats two brands as distinct iff their
 * `B` literals differ.
 *
 * Because every brand in the workspace now shares this single `brand`
 * symbol, distinctness rests **entirely** on each type's `B` literal: two
 * brands with the same literal would collapse into the same type. Every
 * brand literal in use is unique today; the {@link Expect}/{@link AllDistinct}
 * tripwire in `index.ts` (which `tsc --build` checks) fails the build if a
 * future literal collision ever unifies two of this package's brands. A
 * single-brand file (e.g. `@omnesis/core`'s `WsCorrelationId`) has no pair to
 * collide, so it needs no guard.
 */
declare const brand: unique symbol;

/** Nominal brand: `T` carried at runtime, distinguished by the `B` literal. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

// ── Compile-time distinctness assertions ──────────────────────────────────
//
// These pin the load-bearing invariant introduced by the shared `brand`
// symbol: branded types stay mutually distinct only as long as their `B`
// literals do. They are type-only (erased at runtime) and exist to make a
// literal collision a hard `tsc --build` failure rather than a silent
// type-merge. Used by the assertion in `index.ts`.

/** `true` iff `A` and `B` are the exact same type (invariant comparison). */
type IsEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** `true` iff `Head` is distinct from every element of `Rest`. */
type DistinctFromAll<Head, Rest extends readonly unknown[]> = Rest extends readonly [
  infer R,
  ...infer Tail,
]
  ? IsEqual<Head, R> extends true
    ? false
    : DistinctFromAll<Head, Tail>
  : true;

/** `true` iff every element of the tuple is pairwise distinct from the others. */
export type AllDistinct<T extends readonly unknown[]> = T extends readonly [
  infer Head,
  ...infer Tail,
]
  ? DistinctFromAll<Head, Tail> extends true
    ? AllDistinct<Tail>
    : false
  : true;

/** Compile-time assertion: instantiating with anything but `true` is a type error. */
export type Expect<T extends true> = T;
