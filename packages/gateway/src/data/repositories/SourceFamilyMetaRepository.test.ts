// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SourceId } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { setSyncState, getSourceMeta } from "./SyncStateRepository.js";
import { setSourceFamilyMeta } from "./SourceFamilyMetaRepository.js";
import { markSourceCleanupDone } from "./SourceRepository.js";
import { deleteAllBySource } from "./DocumentRepository.js";

let path: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  path = `/tmp/omnesis-source-family-${randomUUID()}.db`;
  db = createDatabase(path);
  db.prepare(
    "INSERT INTO devices (id, name, kind, paired_at) VALUES ('dev-1', 'a-collector', 'collector', 0)",
  ).run();
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
});

function declare(sourceId: string, label: string, familyLabel: string): void {
  // The account has to exist as an account, not merely as a cursor row: the
  // prune asks the register of accounts whether the family still has members.
  const colon = sourceId.indexOf(":");
  db.prepare(
    `INSERT OR IGNORE INTO sources (id, type, account_id, device_id, config, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 'dev-1', '{}', 1, 0, 0)`,
  ).run(sourceId, sourceId.slice(0, colon), sourceId.slice(colon + 1));
  setSyncState(db, sourceId, { phase: "done" }, { label, family: { label: familyLabel } });
}

/** Remove the account row, as a real removal does before its sweep finishes. */
function forget(sourceId: string): void {
  db.prepare("DELETE FROM sources WHERE id = ?").run(sourceId);
}

/**
 * A family's identity is declared in code, so every account of that type
 * re-pushes the same values on every sync page. Repeating a declaration must
 * not cost the writer thread a page.
 */
describe("re-declaring a family", () => {
  /**
   * Rows this connection has written. A wall-clock stamp cannot tell a
   * skipped write from one that landed inside the same millisecond.
   */
  function rowsWritten(): number {
    return db.prepare<[], { n: number }>("SELECT total_changes() AS n").get()!.n;
  }

  test("writes nothing when every field is what is already stored", () => {
    declare("example-browser:one", "BrowserOne", "Browsers");
    const before = rowsWritten();

    setSourceFamilyMeta(db, "example-browser", { label: "Browsers" });

    expect(rowsWritten() - before).toBe(0);
  });

  test("still lands when a field actually changes", () => {
    declare("example-browser:one", "BrowserOne", "Browsers");
    declare("example-browser:one", "BrowserOne", "Web browsers");

    expect(getSourceMeta(db)["example-browser"]).toEqual({ label: "Web browsers" });
  });

  test("a second account of the type declaring the same family writes nothing", () => {
    declare("example-browser:one", "BrowserOne", "Browsers");
    declare("example-browser:two", "BrowserTwo", "Browsers");
    const before = rowsWritten();

    setSourceFamilyMeta(db, "example-browser", { label: "Browsers" });

    expect(rowsWritten() - before).toBe(0);
  });
});

/**
 * A family declaration outlives any one of its accounts, so removing an
 * account cannot take it — but a family whose last account is gone would
 * otherwise be served forever on a public route, with nothing to remove it.
 */
describe("pruning a family declaration", () => {
  test("survives removing one of several accounts", () => {
    declare("example-browser:one", "BrowserOne", "Browsers");
    declare("example-browser:two", "BrowserTwo", "Browsers");

    deleteAllBySource(db, "example-browser:one");
    forget("example-browser:one");
    markSourceCleanupDone(db, SourceId("example-browser:one"));

    expect(getSourceMeta(db)["example-browser"]).toEqual({ label: "Browsers" });
  });

  test("goes with the last account of its type", () => {
    declare("example-browser:one", "BrowserOne", "Browsers");

    deleteAllBySource(db, "example-browser:one");
    forget("example-browser:one");
    markSourceCleanupDone(db, SourceId("example-browser:one"));

    expect(getSourceMeta(db)["example-browser"]).toBeUndefined();
  });

  test("a sibling type's removal leaves it alone", () => {
    // A string-prefix test would call `example-browser` a survivor of
    // `example-browser-archive` and never prune either.
    declare("example-browser:one", "BrowserOne", "Browsers");
    declare("example-browser-archive:one", "ArchiveOne", "Archives");

    deleteAllBySource(db, "example-browser-archive:one");
    forget("example-browser-archive:one");
    markSourceCleanupDone(db, SourceId("example-browser-archive:one"));

    expect(getSourceMeta(db)["example-browser"]).toEqual({ label: "Browsers" });
    expect(getSourceMeta(db)["example-browser-archive"]).toBeUndefined();
  });

  test("a resync is not a removal", () => {
    // `deleteAllBySource` alone is what a resync does; nothing is pruned until
    // the removal's own cleanup says the source is gone.
    declare("example-browser:one", "BrowserOne", "Browsers");
    deleteAllBySource(db, "example-browser:one");

    expect(getSourceMeta(db)["example-browser"]).toEqual({ label: "Browsers" });
  });
});
