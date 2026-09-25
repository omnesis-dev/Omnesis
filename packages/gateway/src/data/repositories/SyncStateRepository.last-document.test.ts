// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// `last_document_at` records when a source last actually produced something, as
// distinct from `last_synced_at`, which advances on every successful cycle —
// including the empty ones. The distinction is the entire basis of staleness
// detection: a source whose local feed has silently stalled keeps a perfectly
// fresh `last_synced_at` forever, because opening a frozen file and finding
// nothing new *is* a successful sync. Only a page that carried documents may
// advance this column, so these tests pin the empty-page case hardest.

import { randomUUID } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../db.js";
import { setSyncState, getSyncState } from "./SyncStateRepository.js";
import { upsertWithCursor } from "./DocumentRepository.js";

let dbPath: string;
let db: ReturnType<typeof createDatabase>;
const SRC = "things:local";

beforeEach(() => {
  dbPath = `/tmp/omnesis-syncstate-lastdoc-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

describe("setSyncState — last_document_at", () => {
  test("a page carrying documents stamps the column", () => {
    setSyncState(db, SRC, { phase: "incremental" }, undefined, undefined, true);
    expect(getSyncState(db, SRC)?.last_document_at).toBeTruthy();
  });

  test("a page carrying no documents leaves it NULL", () => {
    setSyncState(db, SRC, { phase: "incremental" }, undefined, undefined, false);
    expect(getSyncState(db, SRC)?.last_document_at).toBeNull();
  });

  // The case the whole feature turns on: sync keeps succeeding against a frozen
  // file, so `last_synced_at` marches on while `last_document_at` must not.
  test("empty pages advance last_synced_at but never the document stamp", async () => {
    setSyncState(db, SRC, { phase: "bootstrap" }, undefined, undefined, true);
    const stamped = getSyncState(db, SRC);

    for (let i = 0; i < 3; i++) {
      // Both columns hold millisecond-resolution ISO timestamps; without a gap
      // the "last_synced_at moved" half of the assertion can't distinguish the
      // writes.
      await new Promise((r) => setTimeout(r, 5));
      setSyncState(db, SRC, { phase: "incremental", n: i }, undefined, undefined, false);
    }
    const after = getSyncState(db, SRC);

    expect(after?.last_document_at).toBe(stamped?.last_document_at);
    expect(after?.last_synced_at).not.toBe(stamped?.last_synced_at);
  });

  test("a later page with documents moves the stamp forward", async () => {
    setSyncState(db, SRC, { phase: "bootstrap" }, undefined, undefined, true);
    const first = getSyncState(db, SRC)?.last_document_at;

    // The column holds millisecond-resolution ISO timestamps, so two writes in
    // the same millisecond would be indistinguishable.
    await new Promise((r) => setTimeout(r, 5));
    setSyncState(db, SRC, { phase: "incremental" }, undefined, undefined, true);

    expect(getSyncState(db, SRC)?.last_document_at).not.toBe(first);
  });

  // Cursor-only callers (metadata refresh, hand-written cursor writes) pass no
  // flag at all and must not disturb a stamp another path set.
  test("the default omits the flag and preserves an existing stamp", () => {
    setSyncState(db, SRC, { phase: "bootstrap" }, undefined, undefined, true);
    const stamped = getSyncState(db, SRC)?.last_document_at;

    setSyncState(db, SRC, { phase: "incremental" });

    expect(getSyncState(db, SRC)?.last_document_at).toBe(stamped);
  });
});

// The tests above drive `setSyncState` directly. This one goes through the real
// ingest path, because the flag it passes — whether the page carried documents —
// is computed in `upsertWithCursor` and was otherwise unproven end to end.
describe("upsertWithCursor — stamping last_document_at", () => {
  function doc(externalId: string) {
    return {
      providerId: "things:local",
      sourceId: SRC,
      externalId,
      type: "task" as const,
      title: `Task ${externalId}`,
      content: `Body of ${externalId}`,
      contentHash: `hash-${externalId}`,
      metadata: {},
      sourceCreatedAt: "2026-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  test("a page carrying documents stamps the column", () => {
    upsertWithCursor(db, {
      providerId: "things:local",
      sourceId: SRC,
      documents: [doc("t1")],
      deletedExternalIds: [],
      cursor: { phase: "bootstrap" },
      hasMore: false,
    });
    expect(getSyncState(db, SRC)?.last_document_at).toBeTruthy();
  });

  // The case the feature exists for: a source reading a frozen file keeps
  // completing empty cycles, and only this column reveals that nothing arrived.
  test("an empty page advances the sync time but not the document stamp", async () => {
    upsertWithCursor(db, {
      providerId: "things:local",
      sourceId: SRC,
      documents: [doc("t1")],
      deletedExternalIds: [],
      cursor: { phase: "bootstrap" },
      hasMore: false,
    });
    const stamped = getSyncState(db, SRC);

    await new Promise((r) => setTimeout(r, 5));
    upsertWithCursor(db, {
      providerId: "things:local",
      sourceId: SRC,
      documents: [],
      deletedExternalIds: [],
      cursor: { phase: "incremental" },
      hasMore: false,
    });
    const after = getSyncState(db, SRC);

    expect(after?.last_document_at).toBe(stamped?.last_document_at);
    expect(after?.last_synced_at).not.toBe(stamped?.last_synced_at);
  });
});
