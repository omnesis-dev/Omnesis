// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A removed source's documents must not come back.
 *
 * Unregistering a source on the collector does not cancel a sync that is
 * already paging it, so a page in flight when the operator hits Remove lands
 * after the gateway has purged the source. Nothing reclaims those rows: there
 * is no `sources` row to list them under, the removal tombstone is already
 * marked complete, and the stats worker manufactures a fresh stats row from
 * the orphans so they reappear in `/status` and get indexed — searchable
 * content for a source the operator deleted.
 *
 * The tombstone was built to stop precisely this, and only ever guarded push
 * sources: a collector's `write:*` token skipped the gate entirely, and the
 * collector's primary ingest path never consulted it at all.
 */

import { existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ProviderId, SourceId, SCOPE_WRITE_ALL } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import { clearSourceRemoved, markSourceRemoved } from "../../data/repositories/SourceRepository.js";
import { directWriteGate } from "../../write-gate.js";
import { DocumentService } from "./DocumentService.js";
import { EventService } from "./EventService.js";
import type Database from "better-sqlite3";

const SOURCE = "gmail:maya.reeves@example.com";
const PROVIDER = "google";

let dbPath: string;
let db: Database.Database;
let documents: DocumentService;

function page(externalId: string) {
  return {
    callerScopes: [SCOPE_WRITE_ALL],
    body: {
      providerId: PROVIDER,
      sourceId: SOURCE,
      documents: [
        {
          providerId: PROVIDER,
          sourceId: SOURCE,
          externalId,
          title: "Quarterly review",
          content: "Agenda and notes.",
          contentHash: `hash-${externalId}`,
          metadata: { tags: ["inbox"] },
          sourceCreatedAt: "2026-03-10T00:00:00Z",
          sourceUpdatedAt: "2026-03-10T00:00:00Z",
        },
      ],
      hasMore: false,
      cursor: { historyId: 42 },
    },
  };
}

function storedCount(): number {
  return (
    db
      .prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM documents WHERE source_id = ?")
      .get(SOURCE)?.n ?? 0
  );
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  documents = new DocumentService({
    db,
    writeGate: directWriteGate(db),
    events: new EventService(db),
  } as unknown as ConstructorParameters<typeof DocumentService>[0]);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix, { force: true });
  }
});

describe("ingest for a removed source", () => {
  test("a page that lands after the removal is refused, not stored", async () => {
    // The exact shape of the incident: the source is removed, then a sync that
    // was already in flight delivers its next page.
    await documents.upsertWithCursor(page("before-removal"));
    expect(storedCount()).toBe(1);

    markSourceRemoved(db, SourceId(SOURCE), { cleanupPending: true });

    const result = await documents.upsertWithCursor(page("after-removal"));
    expect(result.ingested).toBe(0);
    expect(result.rejectedAsRemoved).toBe(true);
    // Nothing new landed. (The pre-removal document is the sweep's business,
    // not this gate's.)
    expect(storedCount()).toBe(1);
  });

  test("the repository choke point drops removed-source documents", () => {
    markSourceRemoved(db, SourceId(SOURCE), { cleanupPending: true });

    upsertDocuments(db, page("direct-write").body.documents);

    expect(storedCount()).toBe(0);
  });

  test("the collector's write:* token does not bypass it", async () => {
    // The gate that existed short-circuited for `write:*` before it ever
    // looked at the tombstone, which is why pull sources were unprotected
    // while push sources were fine.
    markSourceRemoved(db, SourceId(SOURCE), { cleanupPending: true });
    const result = await documents.upsertWithCursor({
      ...page("collector-page"),
      callerScopes: [SCOPE_WRITE_ALL],
    });
    expect(result.ingested).toBe(0);
    expect(storedCount()).toBe(0);
  });

  test("a completed removal still refuses — the tombstone outlives the purge", async () => {
    // `cleanup_done_at` being set means the purge finished, not that the
    // source is welcome back. An abandoned page loop can outlive the sweep.
    markSourceRemoved(db, SourceId(SOURCE));
    const result = await documents.upsertWithCursor(page("late-page"));
    expect(result.ingested).toBe(0);
    expect(storedCount()).toBe(0);
  });

  test("re-adding the source lets its documents through again", async () => {
    // Registering clears the tombstone, which must genuinely re-open ingest —
    // otherwise a re-added account silently never syncs.
    markSourceRemoved(db, SourceId(SOURCE));
    expect((await documents.upsertWithCursor(page("blocked"))).ingested).toBe(0);

    clearSourceRemoved(db, SourceId(SOURCE));

    const result = await documents.upsertWithCursor(page("allowed"));
    expect(result.ingested).toBe(1);
    expect(result.rejectedAsRemoved).toBeUndefined();
    expect(storedCount()).toBe(1);
  });

  test("an untouched source is unaffected by another's removal", async () => {
    markSourceRemoved(db, SourceId("gmail:jamie.lopez@example.org"));
    const result = await documents.upsertWithCursor(page("sibling"));
    expect(result.ingested).toBe(1);
    expect(storedCount()).toBe(1);
  });
});

describe("what the refusal reports", () => {
  test("it is not an error, so the collector stops instead of retrying forever", async () => {
    // A 4xx/5xx would make the collector re-send the same page indefinitely.
    markSourceRemoved(db, SourceId(SOURCE));
    await expect(documents.upsertWithCursor(page("x"))).resolves.toMatchObject({
      ingested: 0,
      rejectedAsRemoved: true,
    });
  });
});

describe("provider id", () => {
  test("the guard keys on the source, not the provider", async () => {
    // Two sources of one provider: removing one must not mute the other.
    markSourceRemoved(db, SourceId(SOURCE));
    const sibling = {
      callerScopes: [SCOPE_WRITE_ALL],
      body: {
        ...page("sibling-doc").body,
        sourceId: "gmail:jamie.lopez@example.org",
        providerId: ProviderId(PROVIDER),
      },
    };
    expect((await documents.upsertWithCursor(sibling)).ingested).toBe(1);
  });
});
