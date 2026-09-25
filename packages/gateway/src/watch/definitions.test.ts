// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The store, opened over a file some earlier build left behind.
 *
 * This is constructed at boot, at module scope, with nothing above it catching
 * anything — so a statement that throws against an older table shape is not a
 * degraded start, it is a process that exits and a service that restarts into
 * the same throw. A fresh config dir cannot show it: `CREATE TABLE IF NOT
 * EXISTS` makes the new shape whole in one step, and only an install that has
 * booted before takes the path where a column arrives separately.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WatchDefinitionStore } from "./definitions.js";
import type { EncryptedSqliteDatabase } from "../sqlite-encryption.js";
import type { StoredWatch } from "./definitions.js";

let db: EncryptedSqliteDatabase;

beforeEach(() => {
  db = new Database(":memory:") as unknown as EncryptedSqliteDatabase;
});

afterEach(() => {
  db.close();
});

/** The table as a build before the request key wrote it. */
function olderShape(): void {
  db.exec(`CREATE TABLE watch_defs (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    status         TEXT NOT NULL,
    dsl_json       TEXT NOT NULL,
    added_at       TEXT NOT NULL,
    from_seq       INTEGER NOT NULL DEFAULT 0,
    note           TEXT,
    compile_run_id TEXT
  );`);
}

function watch(overrides: Partial<StoredWatch> = {}): StoredWatch {
  return {
    id: "w-1",
    name: "a-watch",
    status: "active",
    dsl: { watch: { name: "a-watch" } },
    addedAt: "2026-03-01T09:00:00.000Z",
    fromSeq: 0,
    note: null,
    compileRunId: null,
    requestKey: null,
    referenceDigest: null,
    ...overrides,
  };
}

describe("opening the store over a table an older build wrote", () => {
  it("adds what is missing rather than failing the boot", () => {
    olderShape();
    db.prepare(
      `INSERT INTO watch_defs (id, name, status, dsl_json, added_at, from_seq, note, compile_run_id)
       VALUES ('w-old', 'kept', 'active', '{"watch":{"name":"kept"}}', '2026-01-01T00:00:00.000Z', 0, NULL, NULL)`,
    ).run();

    const store = new WatchDefinitionStore(db);

    // The watch that was already there survives, with the new column reading
    // as the absence it is.
    expect(store.get("w-old")).toMatchObject({ name: "kept", requestKey: null });
  });

  it("indexes the asker's key on that path too, not only on a fresh one", () => {
    // The index is what makes the key unique. Created alongside the table it
    // never runs on an upgraded install — and a uniqueness guarantee that
    // holds only on installs that have never booted is not one.
    olderShape();
    const store = new WatchDefinitionStore(db);
    store.put(watch({ id: "w-a", requestKey: "one-request" }));

    expect(() => store.put(watch({ id: "w-b", requestKey: "one-request" }))).toThrow(/UNIQUE/);
  });
});

describe("the watch an asker's own key installed", () => {
  it("is found again by that key, and nothing else is", () => {
    const store = new WatchDefinitionStore(db);
    store.put(watch({ id: "w-a", requestKey: "device-1\u0000one-request" }));
    store.put(watch({ id: "w-b", requestKey: null }));

    expect(store.findByRequestKey("device-1\u0000one-request")?.id).toBe("w-a");
    expect(store.findByRequestKey("device-2\u0000one-request")).toBeNull();
  });

  it("lets two watches carry no key at all", () => {
    // Most watches have none — an operator installing one is a person clicking
    // once, not a request that can be retried — and a unique index that
    // counted absences would allow exactly one of them on the install.
    const store = new WatchDefinitionStore(db);
    store.put(watch({ id: "w-a" }));

    expect(() => store.put(watch({ id: "w-b" }))).not.toThrow();
  });

  it("keeps the key when the watch is rewritten in place", () => {
    // A rewrite keeps the identity, and the key is how the asker finds it. An
    // update that dropped it would let the next retry compile a second watch.
    const store = new WatchDefinitionStore(db);
    store.put(watch({ id: "w-a", requestKey: "device-1\u0000one-request" }));
    store.put(watch({ id: "w-a", name: "renamed", requestKey: "device-1\u0000one-request" }));

    expect(store.findByRequestKey("device-1\u0000one-request")?.name).toBe("renamed");
  });
});
