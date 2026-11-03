// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Read ports: one declaration of a set of reads, run either on an io read
 * worker or on the caller's own handle.
 *
 * A port is declared once as an object of plain functions that take a
 * database handle first (`(db, ...args) => result`). From that one object:
 *
 *  - `ioReadHandlers(reads)` gives the worker its `io.<name>` handlers, spread
 *    into `ioHandlers` in `io-handlers.ts`;
 *  - `ioReadPort(reads, call)` gives the gateway the async port that enqueues
 *    each read as its `io.<name>` op, spread into `ioGateFromScheduler`;
 *  - `directReadPort(reads, db)` gives a runtime without a read worker (the
 *    storage-only tests, a store opened outside the gateway) the same port on
 *    its own handle.
 *
 * Both forms run the very same function, so they return the same rows; the
 * worker form returns them through a structured clone, which is why a read's
 * arguments and result must be plain data (arrays, not sets; no class
 * instances). A read on the worker takes its own snapshot when it runs, after
 * every write the caller has already awaited has committed.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

/** A read against a database handle; the handle is always the first argument. */
type HandleRead = (db: Db, ...args: never[]) => unknown;

/** A port's declaration: its reads, by name. */
export type HandleReads = Readonly<Record<string, HandleRead>>;

type ReadArgs<F> = F extends (db: Db, ...args: infer A) => unknown ? A : never;
type ReadResult<F> = F extends (...args: never[]) => infer R ? Awaited<R> : never;

/** The asynchronous form of a port's reads, as callers use it. */
export type ReadPort<R extends HandleReads> = {
  readonly [K in keyof R]: (...args: ReadArgs<R[K]>) => Promise<ReadResult<R[K]>>;
};

/** A port's reads under their worker op names. */
export type IoReadHandlers<R extends HandleReads> = {
  readonly [K in keyof R & string as `io.${K}`]: R[K];
};

/** The worker op name of each of a port's reads. */
export type IoReadOpName<R extends HandleReads> = `io.${keyof R & string}`;

function entries<R extends HandleReads>(reads: R): Array<[string, HandleRead]> {
  return Object.entries(reads) as Array<[string, HandleRead]>;
}

/** The port's reads on the caller's own handle. A read that throws rejects, as on the worker. */
export function directReadPort<R extends HandleReads>(reads: R, db: Db): ReadPort<R> {
  return Object.fromEntries(
    entries(reads).map(([name, read]) => [
      name,
      (...args: never[]) => new Promise<unknown>((resolve) => resolve(read(db, ...args))),
    ]),
  ) as unknown as ReadPort<R>;
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
