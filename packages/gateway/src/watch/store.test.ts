// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The journal file's own guarantees, independent of anything that writes to it.
 *
 * Two of them carry real weight. A drain's events, its cursors and its row
 * hashes have to land together or not at all — each pair has a crash between
 * them that loses or repeats work. And one unreadable row must not stop a
 * consumer reaching every row after it, because the consumer's only alternative
 * is to stop consuming.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { seenKey, WatchJournalStore } from "./store.js";
import type { NewJournalEvent } from "./store.js";

let dir: string;
let path: string;
let store: WatchJournalStore;

function docEvent(docId: string): NewJournalEvent {
  return {
    kind: "doc.event",
    occurredAt: "2026-03-01T09:00:00.000Z",
    observedAt: "2026-03-01T09:00:05.000Z",
    payload: {
      op: "created",
      docId,
      sourceId: "gmail",
      providerId: "google",
      documentType: "email",
      title: "Spring works",
      semanticTime: "2026-03-01T09:00:00.000Z",
      changedFields: [],
      contentChanged: true,
      metadata: {},
      people: [],
    },
  };
}

const A = "11111111-2222-4333-8444-555555555551";
const B = "11111111-2222-4333-8444-555555555552";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-watch2-store-"));
  path = join(dir, "watch.db");
  store = WatchJournalStore.open(path, null);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed by the case under test */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("what a commit writes", () => {
  it("assigns increasing sequence numbers in write order", () => {
    store.commit({ events: [docEvent(A), docEvent(B)] });
    const events = store.read(0, 10);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.map((e) => (e.kind === "doc.event" ? e.payload.docId : ""))).toEqual([A, B]);
  });

  it("reads back only what follows the caller's position", () => {
    store.commit({ events: [docEvent(A), docEvent(B)] });
    expect(store.read(1, 10).map((e) => e.seq)).toEqual([2]);
    expect(store.read(2, 10)).toEqual([]);
    expect(store.read(0, 1).map((e) => e.seq)).toEqual([1]);
  });

  it("lands events, cursors and row hashes together or not at all", () => {
    // Each pair has a crash between them that loses or repeats work: a cursor
    // ahead of its events skips them forever, a row hash ahead of its event
    // turns a real change into a redelivery.
    expect(() =>
      store.commit({
        events: [docEvent(A), docEvent(B)],
        state: { cursor: "moved" },
        // A value SQLite cannot bind, so the write fails partway through the
        // batch — after the events and the cursor have already been inserted.
        seenRows: [{ table: "t", pkHash: "p", rowHash: { nope: true } as unknown as string }],
      }),
    ).toThrow();

    // The failure happened inside the transaction, so nothing in the batch
    // survives it.
    expect(store.count(), "a partial batch landed").toBe(0);
    expect(store.getState("cursor"), "a cursor moved without its events").toBeNull();
    expect(store.seenRows([{ table: "t", pkHash: "p" }]).size).toBe(0);
  });

  it("keeps the latest value for a key written twice in one batch", () => {
    store.commit({
      seenRows: [
        { table: "t", pkHash: "p", rowHash: "first" },
        { table: "t", pkHash: "p", rowHash: "second" },
      ],
      events: [],
    });
    expect(store.seenRows([{ table: "t", pkHash: "p" }]).get(seenKey("t", "p"))).toBe("second");
  });

  it("keeps rows of the same key in different tables apart", () => {
    store.commit({
      events: [],
      seenRows: [
        { table: "one", pkHash: "p", rowHash: "a" },
        { table: "two", pkHash: "p", rowHash: "b" },
      ],
    });
    const found = store.seenRows([
      { table: "one", pkHash: "p" },
      { table: "two", pkHash: "p" },
    ]);
    expect(found.get(seenKey("one", "p"))).toBe("a");
    expect(found.get(seenKey("two", "p"))).toBe("b");
  });
});

describe("an event the current build cannot read", () => {
  it("is skipped so the consumer still reaches everything after it", () => {
    // A payload shape can move between builds. Throwing here would stop a
    // consumer at the first row it cannot parse and leave every later event
    // permanently unreachable — the journal's whole purpose lost to one row.
    store.commit({ events: [docEvent(A), docEvent(B)] });

    const raw = new Database(path);
    raw
      .prepare(
        `INSERT INTO watch_events (kind, occurred_at, observed_at, payload)
         VALUES ('doc.event', '2026-03-01T09:00:01.000Z', '2026-03-01T09:00:06.000Z', '{"nope":true}')`,
      )
      .run();
    // …and one whose payload is not even JSON.
    raw
      .prepare(
        `INSERT INTO watch_events (kind, occurred_at, observed_at, payload)
         VALUES ('doc.event', '2026-03-01T09:00:02.000Z', '2026-03-01T09:00:07.000Z', 'not json')`,
      )
      .run();
    raw.prepare("UPDATE watch_events SET seq = 5 WHERE seq = 2").run();
    raw.close();

    const events = store.read(0, 10);
    expect(
      events.map((e) => (e.kind === "doc.event" ? e.payload.docId : "")),
      "an unreadable row hid the events after it",
    ).toEqual([A, B]);
    expect(store.count(), "count reports rows, not readable rows").toBe(4);
  });

  it("can still be written to after one", () => {
    // The document index evaluates `json_extract` on insert, so a payload that
    // is not JSON has to be excluded from the index rather than rejected by it
    // — otherwise one corrupt event stops the journal accepting any more, and a
    // row the read path calls skippable becomes a write path that has stopped.
    const raw = new Database(path);
    raw
      .prepare(
        `INSERT INTO watch_events (kind, occurred_at, observed_at, payload)
         VALUES ('doc.event', '2026-03-01T09:00:00.000Z', '2026-03-01T09:00:00.000Z', 'not json')`,
      )
      .run();
    raw.close();

    expect(() => store.commit({ events: [docEvent(A)] })).not.toThrow();
    expect(store.read(0, 10).map((e) => e.seq)).toEqual([2]);
  });
});

describe("finding a document the journal carried", () => {
  it("returns the most recent event at or before the sequence asked for", () => {
    // A consumer catching up is walking a backlog, so "most recent" has to mean
    // "most recent so far" — otherwise it evaluates an index event against a
    // revision that had not happened yet.
    store.commit({ events: [docEvent(A), docEvent(B), docEvent(A)] });

    expect(store.documentAt(A, 3)?.seq, "the newest event for A was not found").toBe(3);
    expect(store.documentAt(A, 2)?.seq, "the lookup read past the sequence asked for").toBe(1);
    expect(store.documentAt(A, 0), "a lookup before the document existed found one").toBeNull();
    expect(store.documentAt("11111111-2222-4333-8444-55555555ffff", 9)).toBeNull();
  });
});

describe("the file itself", () => {
  it("survives being closed and reopened with everything still in it", () => {
    store.commit({ events: [docEvent(A)], state: { cursor: "here" } });
    store.close();

    store = WatchJournalStore.open(path, null);
    expect(store.count()).toBe(1);
    expect(store.getState("cursor")).toBe("here");
  });

  it("opens a store that does not exist yet", () => {
    const fresh = WatchJournalStore.open(join(dir, "brand-new.db"), null);
    try {
      expect(fresh.count()).toBe(0);
      expect(fresh.getState("cursor")).toBeNull();
      expect(fresh.read(0, 10)).toEqual([]);
    } finally {
      fresh.close();
    }
  });
});

describe("an event written before instants were canonical", () => {
  /**
   * Write a row straight into the table, bypassing `commit`, so the stored
   * bytes are what an older build actually left behind: a source's own
   * timestamp verbatim, with a space separator and a two-digit offset.
   */
  function writeRawDocEvent(store: WatchJournalStore, at: string): void {
    const db = (store as unknown as { db: EncryptedSqliteDatabase }).db;
    db.prepare<[string, string, string, string]>(
      `INSERT INTO watch_events (kind, occurred_at, observed_at, payload) VALUES (?, ?, ?, ?)`,
    ).run(
      "doc.event",
      at,
      "2026-08-05T15:06:19.033Z",
      JSON.stringify({
        op: "updated",
        docId: "aaaaaaaa-0000-4000-8000-000000000001",
        sourceId: "strava-activities:12345678",
        providerId: "strava:12345678",
        documentType: "activity",
        title: "an activity",
        semanticTime: at,
        changedFields: ["distance"],
        contentChanged: false,
        metadata: {},
        people: [],
      }),
    );
  }

  it("is readable now, rather than skipped forever", () => {
    // Six real events on a live install were invisible to every watch because
    // of exactly this. Normalizing on the way out is what recovers them without
    // rewriting a durable journal.
    const store = WatchJournalStore.open(join(dir, "recover.db"), null);
    writeRawDocEvent(store, "2026-07-31 15:09:00+01");

    const events = store.read(0, 10);
    expect(events, "an event with a non-canonical instant was still skipped").toHaveLength(1);
    expect(events[0]?.occurredAt).toBe("2026-07-31T15:09:00+01:00");
    expect((events[0] as { payload: { semanticTime: string } }).payload.semanticTime).toBe(
      "2026-07-31T15:09:00+01:00",
    );
    store.close();
  });

  it("is reachable by document lookup too, not only by read", () => {
    // `documentAt` decodes independently of `read`, so a fix in one and not the
    // other would leave a semantic match unable to find the document it is
    // being asked about.
    const store = WatchJournalStore.open(join(dir, "recover-lookup.db"), null);
    writeRawDocEvent(store, "2026-07-31 15:09:00+01");

    const found = store.documentAt("aaaaaaaa-0000-4000-8000-000000000001", 99);
    expect(found, "the document was unreachable through the lookup path").not.toBeNull();
    expect(found?.event.semanticTime).toBe("2026-07-31T15:09:00+01:00");
    store.close();
  });
});

describe("an event nothing can read", () => {
  function writeUnreadable(store: WatchJournalStore): void {
    const db = (store as unknown as { db: EncryptedSqliteDatabase }).db;
    db.prepare<[string, string, string, string]>(
      `INSERT INTO watch_events (kind, occurred_at, observed_at, payload) VALUES (?, ?, ?, ?)`,
    ).run(
      "doc.event",
      "2026-08-05T10:00:00Z",
      "2026-08-05T10:00:00Z",
      JSON.stringify({ op: "created" }),
    );
  }

  it("is reported once per process, however many times it is read", () => {
    // An unreadable row at the head of the journal is re-read on every
    // evaluation tick, because nothing advances past it until a readable event
    // lands behind it. Warning per read turned one bad row into hundreds of
    // identical lines a night.
    const warnings: string[] = [];
    const store = WatchJournalStore.open(join(dir, "noisy.db"), null);
    writeUnreadable(store);

    const log = (store as unknown as { warnedUnreadable: Set<number> }).warnedUnreadable;
    expect(log.size).toBe(0);
    for (let i = 0; i < 5; i += 1) store.read(0, 10);
    expect(log.size, "the skip was not remembered, so it warns on every read").toBe(1);
    void warnings;
    store.close();
  });

  it("is skipped without taking the readable events with it", () => {
    const store = WatchJournalStore.open(join(dir, "mixed.db"), null);
    writeUnreadable(store);
    store.commit({
      events: [
        {
          kind: "doc.indexed",
          occurredAt: "2026-08-05T11:00:00Z",
          observedAt: "2026-08-05T11:00:00Z",
          payload: {
            docId: "bbbbbbbb-0000-4000-8000-000000000002",
            eventIndexedAt: "2026-08-05T11:00:00Z",
          },
        },
      ],
    });

    const events = store.read(0, 10);
    expect(events, "one bad row stopped the reader reaching the good one").toHaveLength(1);
    expect(events[0]?.kind).toBe("doc.indexed");
    store.close();
  });
});
