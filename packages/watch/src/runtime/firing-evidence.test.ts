// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The documents a firing was reached through, kept with the firing.
 *
 * They were already collected — the trace carries them, and the delivery path
 * hands them to an agent — but the trace is bounded and rolls off while the
 * firing is kept forever. A firing whose evidence lived only in the trace
 * becomes unexplainable the week after it happened, which is exactly when
 * someone asks about it.
 *
 * A store written before the column exists must keep working, and its old
 * firings must read as having no evidence rather than failing the query that
 * names the column — the runtime is down either way, and one of those is
 * silent.
 *
 * All fixture data is invented.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { WatchStateStore } from "./state.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "watch-firing-evidence-"));
  scratch.push(dir);
  return dir;
}

const FIRED_AT = "2026-05-04T09:15:00.000Z";
const QUOTE = "d1e2f3a4-0000-4000-8000-000000000001";
const ATTACHMENT = "d1e2f3a4-0000-4000-8000-000000000002";

describe("what a firing was reached through", () => {
  it("survives a restart, in the order it was collected", () => {
    // Order is the runtime's, not the ids'. A join over two document arms
    // contributes both, and which came first is part of the answer.
    const path = join(tempDir(), "evidence.db");
    const first = new WatchStateStore(path);
    first.recordFiring("w-1", 7, "mail", "k:0", FIRED_AT, {}, null, [QUOTE, ATTACHMENT]);
    first.close();

    const second = new WatchStateStore(path);
    expect(second.firings("w-1")[0]?.documentIds).toEqual([QUOTE, ATTACHMENT]);
    second.close();
  });

  it("is empty, not absent, for a firing with nothing behind it", () => {
    // A watch that comes true on a clock, a row or a deadline has no evidence
    // to show, and that is the watch working. Callers render an empty list as
    // nothing at all rather than as something missing.
    const store = new WatchStateStore();
    store.recordFiring("w-1", 1, "daily", "k:0", FIRED_AT, {}, null, []);

    expect(store.firings("w-1")[0]?.documentIds).toEqual([]);
    store.close();
  });

  it("does not restamp a replayed firing with different evidence", () => {
    // The unique constraint is what stops a resumed run double-counting, and
    // it has to hold for what the firing says as well as for whether it
    // happened: a replay that rewrote the evidence would change the answer to
    // "why did this fire?" without changing the firing.
    const store = new WatchStateStore();
    expect(store.recordFiring("w-1", 7, "mail", "k:0", FIRED_AT, {}, null, [QUOTE])).toBe(true);
    expect(store.recordFiring("w-1", 7, "mail", "k:0", FIRED_AT, {}, null, [ATTACHMENT])).toBe(
      false,
    );

    expect(store.firings("w-1")).toHaveLength(1);
    expect(store.firings("w-1")[0]?.documentIds).toEqual([QUOTE]);
    store.close();
  });
});

describe("reading a long ledger", () => {
  it("decodes only the most recent, and still hands them back oldest first", () => {
    // A watch that has run for a year holds thousands of firings, each with a
    // JSON payload to decode, and every surface that reads them keeps a page.
    // Unbounded, one route call reads the whole history to show twenty rows.
    const store = new WatchStateStore(join(tempDir(), "long.db"));
    try {
      for (let i = 1; i <= 10; i += 1) {
        store.recordFiring("w-1", i, "mail", "k:0", FIRED_AT, { n: i }, null, []);
      }

      const page = store.firings("w-1", 3);

      expect(
        page.map((f) => f.seq),
        "the page was not the most recent three",
      ).toEqual([8, 9, 10]);
      expect(store.firings("w-1")).toHaveLength(10);
    } finally {
      store.close();
    }
  });

  it("orders by insertion, so a forced firing's negative sequence is still recent", () => {
    // A forced or timer firing carries a negative sequence. Ordered by `seq`,
    // the newest row in the ledger would sort to the bottom and fall out of
    // every page.
    const store = new WatchStateStore(join(tempDir(), "negative.db"));
    try {
      store.recordFiring("w-1", 1, "mail", "k:0", FIRED_AT, {}, null, []);
      store.recordFiring("w-1", 2, "mail", "k:0", FIRED_AT, {}, null, []);
      store.recordFiring("w-1", -1, "mail", "k:0", FIRED_AT, {}, null, [], true);

      expect(store.firings("w-1", 1).map((f) => f.seq)).toEqual([-1]);
    } finally {
      store.close();
    }
  });
});

describe("a store written before the column existed", () => {
  it("gains it on open, and reads its old firings as having no evidence", () => {
    const path = join(tempDir(), "old.db");
    const legacy = new DatabaseConstructor(path);
    legacy.exec(`
      CREATE TABLE watch_firings (
        watch_id     TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        node_id      TEXT NOT NULL,
        key_hash     TEXT NOT NULL,
        fired_at     TEXT NOT NULL,
        noticed_at   TEXT,
        payload_json TEXT NOT NULL,
        UNIQUE (watch_id, seq, node_id, key_hash)
      )`);
    legacy
      .prepare(
        `INSERT INTO watch_firings (watch_id, seq, node_id, key_hash, fired_at, payload_json)
         VALUES ('w-1', 1, 'mail', 'k:0', ?, '{}')`,
      )
      .run(FIRED_AT);
    legacy.close();

    const store = new WatchStateStore(path);
    expect(store.firings("w-1")[0]?.firedAt, "the existing firing was lost").toBe(FIRED_AT);
    expect(store.firings("w-1")[0]?.documentIds).toEqual([]);

    // And it records evidence from here on.
    store.recordFiring("w-1", 2, "mail", "k:0", FIRED_AT, {}, null, [QUOTE]);
    expect(store.firings("w-1")[1]?.documentIds).toEqual([QUOTE]);

    // The same for the column that says whether an operator forced the firing.
    // Absent means organic, which is the truth for every row written before
    // there was a way to force one — and the listing's count reads that column,
    // so a NULL taken for a 1 would stop counting what the watch caught.
    expect(store.firings("w-1")[0]?.forced).toBe(false);
    expect(store.firingCount("w-1")).toBe(2);
    store.recordFiring("w-1", -1, "mail", "k:0", FIRED_AT, {}, null, [], true);
    expect(store.firings("w-1")[2]?.forced).toBe(true);
    expect(store.firingCount("w-1"), "a forced firing was counted as a catch").toBe(2);
    store.close();
  });

  it("reads a column holding something that is not a list of ids as no evidence", () => {
    // Defensive because the column is JSON in a text field: a hand-edited row
    // or a partial write must cost this firing its evidence, not cost the
    // reader the whole ledger.
    const path = join(tempDir(), "corrupt.db");
    const store = new WatchStateStore(path);
    store.recordFiring("w-1", 1, "mail", "k:0", FIRED_AT, {}, null, [QUOTE]);
    store.close();

    const meddled = new DatabaseConstructor(path);
    meddled.prepare("UPDATE watch_firings SET document_ids = ?").run("not json at all");
    meddled.close();

    const reopened = new WatchStateStore(path);
    expect(reopened.firings("w-1")[0]?.documentIds).toEqual([]);
    expect(reopened.firings("w-1")[0]?.firedAt, "one bad column lost the firing").toBe(FIRED_AT);
    reopened.close();
  });
});
