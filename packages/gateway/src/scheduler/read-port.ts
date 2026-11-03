// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Read ports: one declaration of a set of reads, run either on an io read
 * worker or on the caller's own handle.
 *
 * A port is declared once as an object of plain functions that take a
 * database handle first (`(db, ...args) => result`), and registered by adding
 * it to `IO_READS` in `io-read-ports.ts`. From that set:
 *
 *  - `ioReadHandlers` gives the worker one `io.<name>` handler per read, in
 *    `ioHandlers` (`io-handlers.ts`);
 *  - `ioReadOpNames` gives each op its scheduler task in `COMPUTE_OP_DEFS`, and
 *    `ReadPort` with `ioReadPort` give the gateway's `IoGate` the async port
 *    that enqueues each read as its op (`io-ops.ts`).
 *
 * `directReadPort(reads, db)` gives a runtime without a read worker (the
 * storage-only tests, a store opened outside the gateway) the same port on its
 * own handle.
 *
 * Both forms run the very same function, so they return the same rows. The
 * worker form returns them through a structured clone, which keeps sets, maps
 * and dates but drops functions, symbol keys and prototypes, so a read returns
 * plain data and never a class instance. A read is synchronous, and one that
 * finds nothing returns `null`; the worker sends `undefined` as `null` too. A
 * read on the worker takes its own snapshot when it runs, after every write the
 * caller has already awaited has committed.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

/** A read against a database handle; the handle is always the first argument. */
type HandleRead = (db: Db, ...args: never[]) => unknown;

/** A port's declaration: its reads, by name. */
type HandleReads = Readonly<Record<string, HandleRead>>;

type ReadArgs<F> = F extends (db: Db, ...args: infer A) => unknown ? A : never;
/**
 * What a caller receives: the read's own result, synchronous by contract (the
 * worker posts it as it is returned, so a promise would fail to clone), with
 * `undefined` delivered as `null`, as the worker delivers it.
 */
type ReadResult<F> = F extends (...args: never[]) => infer R
  ? [R] extends [PromiseLike<unknown>]
    ? never
    : Exclude<R, undefined> | (undefined extends R ? null : never)
  : never;

/** The asynchronous form of a port's reads, as callers use it. */
export type ReadPort<R extends HandleReads> = {
  readonly [K in keyof R]: (...args: ReadArgs<R[K]>) => Promise<ReadResult<R[K]>>;
};

/** A port's reads under their worker op names. */
type IoReadHandlers<R extends HandleReads> = {
  readonly [K in keyof R & string as `io.${K}`]: R[K];
};

/** The worker op name of each of a port's reads. */
type IoReadOpName<R extends HandleReads> = `io.${keyof R & string}`;

function entries<R extends HandleReads>(reads: R): Array<[string, HandleRead]> {
  return Object.entries(reads) as Array<[string, HandleRead]>;
}

/**
 * The port's reads on the caller's own handle, delivered as the worker
 * delivers them: a read that throws rejects, and `undefined` arrives as `null`.
 */
export function directReadPort<R extends HandleReads>(reads: R, db: Db): ReadPort<R> {
  return Object.fromEntries(
    entries(reads).map(([name, read]) => [
      name,
      (...args: never[]) => new Promise<unknown>((resolve) => resolve(read(db, ...args) ?? null)),
    ]),
  ) as unknown as ReadPort<R>;
}

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

/**
 * Several ports as one set of reads. Read names share one op namespace, so a
 * name two ports both declare is refused rather than one read replacing the
 * other.
 */
export function mergeReadPorts<P extends readonly HandleReads[]>(
  ...ports: P
): UnionToIntersection<P[number]> {
  const merged: Record<string, HandleRead> = {};
  for (const port of ports)
    for (const [name, read] of entries(port)) {
      if (name in merged) throw new Error(`Read port name declared twice: ${name}`);
      merged[name] = read;
    }
  return merged as UnionToIntersection<P[number]>;
}

/** The port's reads as io worker handlers, keyed by op name. */
export function ioReadHandlers<R extends HandleReads>(reads: R): IoReadHandlers<R> {
  return Object.fromEntries(
    entries(reads).map(([name, read]) => [`io.${name}`, read]),
  ) as IoReadHandlers<R>;
}

/** The op names of a port's reads, for their scheduler task definitions. */
export function ioReadOpNames<R extends HandleReads>(reads: R): Array<IoReadOpName<R>> {
  return Object.keys(reads).map((name) => `io.${name}` as IoReadOpName<R>);
}

/** The port, with each read enqueued as its io op through `call`. */
export function ioReadPort<R extends HandleReads>(
  reads: R,
  call: (op: string, args: unknown[]) => Promise<unknown>,
): ReadPort<R> {
  return Object.fromEntries(
    Object.keys(reads).map((name) => [name, (...args: unknown[]) => call(`io.${name}`, args)]),
  ) as unknown as ReadPort<R>;
}
