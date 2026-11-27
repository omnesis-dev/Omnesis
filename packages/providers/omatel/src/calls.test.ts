// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tableWrites } from "@omnesis/source-sdk";
import { buildCallDay, syncCalls, type CallRow } from "./calls.js";
import {
  addCall,
  at,
  callsSourceId,
  omatelFixture,
  providerId,
  type OmatelFixture,
} from "./testing/fixtures.js";
import type { OmatelCursor } from "./group-sync.js";

const PEER = "+12025550141";
const OTHER = "+12025550142";

let fx: OmatelFixture;
beforeEach(() => {
  fx = omatelFixture();
});
afterEach(() => fx.cleanup());

const options = (extra: { dataCutoff?: string; phoneRegion?: string } = {}) => ({
  dataDir: fx.dir,
  sourceId: callsSourceId,
  providerId,
  ...extra,
});

/** Run pages until the cycle ends, as the host does. */
function cycle(cursor: OmatelCursor | null, extra = {}) {
  const pages = [];
  let next = cursor;
  for (;;) {
    const page = syncCalls(next, options(extra));
    pages.push(page);
    next = page.cursor;
    if (!page.hasMore) return { pages, cursor: next, last: page };
  }
}

const records = (page: ReturnType<typeof syncCalls>) =>
  tableWrites(page.analytics)[0] ?? { tableName: "omatel_call_log", records: [] };

describe("omatel call log", () => {
  it("bootstraps one call-log document per UTC day and one row per call", () => {
    const db = fx.calls();
    addCall(db, {
      number: PEER,
      direction: "in",
      outcome: "answered",
      startedAt: at("2026-03-04T09:15"),
      duration: 185,
    });
    addCall(db, {
      number: OTHER,
      direction: "out",
      outcome: "unanswered",
      startedAt: at("2026-03-04T18:02"),
    });
    addCall(db, {
      number: PEER,
      direction: "in",
      outcome: "missed",
      startedAt: at("2026-03-05T07:30"),
    });

    const { last } = cycle(null);

    expect(last.documents?.map((d) => d.externalId)).toEqual([
      "call-log:2026-03-04",
      "call-log:2026-03-05",
    ]);
    const day = last.documents![0]!;
    expect(day.content).toBe(
      [
        "# Calls — 2026-03-04",
        "",
        "**Total:** 2 calls, 3m 5s",
        "",
        `- 09:15 Incoming call ← ${PEER}, 3m 5s`,
        `- 18:02 Outgoing call → ${OTHER} (no answer)`,
      ].join("\n"),
    );
    expect(day.metadata.documentType).toBe("call-log");
    expect(day.metadata.rollingAggregate).toBe(true);
    expect(day.metadata.people).toEqual([
      { role: "participant", name: "You", isSelf: true },
      { role: "participant", phones: [PEER] },
      { role: "participant", phones: [OTHER] },
    ]);
    expect(day.metadata.extra).toMatchObject({
      date: "2026-03-04",
      callCount: 2,
      totalDurationSeconds: 185,
    });

    const write = records(last);
    expect(write.tableName).toBe("omatel_call_log");
    expect(write.records).toHaveLength(3);
    expect(write.records![0]).toEqual({
      id: "1",
      date: "2026-03-04",
      time: "2026-03-04T09:15:00.000Z",
      direction: "incoming",
      outcome: "answered",
      duration_seconds: 185,
      connected: true,
      counterparty: PEER,
    });
    expect(write.presentKeys).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
    expect(last.progress).toMatchObject({ coverage: "complete", percentComplete: 100 });
  });

  it("renders nothing on a cycle where no call changed, and still names every call", () => {
    addCall(fx.calls(), {
      number: PEER,
      direction: "in",
      outcome: "answered",
      startedAt: at("2026-03-04T09:15"),
      duration: 60,
    });
    const first = cycle(null);

    const again = cycle(first.cursor);

    expect(again.pages).toHaveLength(1);
    expect(again.last.documents).toEqual([]);
    expect(again.last.deletedExternalIds).toEqual([]);
    expect(records(again.last).records).toEqual([]);
    // The gateway removes a deleted call only after several spaced snapshots
    // omit it, so an unchanged cycle still sends one.
    expect(records(again.last).presentKeys).toEqual([{ id: "1" }]);
    expect(again.last.issues).toEqual([]);
    expect(again.cursor).toEqual(first.cursor);
  });

  it("re-renders only the day a new call lands on", () => {
    const db = fx.calls();
    addCall(db, {
      number: PEER,
      direction: "in",
      outcome: "answered",
      startedAt: at("2026-03-04T09:15"),
      duration: 60,
    });
    addCall(db, {
      number: PEER,
      direction: "in",
      outcome: "answered",
      startedAt: at("2026-03-05T09:15"),
      duration: 60,
    });
    const first = cycle(null);

    addCall(db, {
      number: OTHER,
      direction: "in",
      outcome: "rejected",
      startedAt: at("2026-03-05T20:00"),
    });
    const next = cycle(first.cursor);

    expect(next.last.documents?.map((d) => d.externalId)).toEqual(["call-log:2026-03-05"]);
    expect(next.last.documents![0]!.content).toContain(
      `- 20:00 Incoming call ← ${OTHER} (declined)`,
    );
    expect(records(next.last).records?.map((r) => r.id)).toEqual(["2", "3"]);
    expect(records(next.last).presentKeys).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
  });

  it("deletes a day whose calls the owner removed, and names the calls left", () => {
    const db = fx.calls();
    addCall(db, {
      number: PEER,
      direction: "in",
      outcome: "missed",
      startedAt: at("2026-03-04T09:15"),
    });
    const kept = addCall(db, {
      number: PEER,
      direction: "out",
      outcome: "answered",
      startedAt: at("2026-03-06T09:15"),
      duration: 30,
    });
    const first = cycle(null);

    db.prepare("DELETE FROM calls WHERE started_at < ?").run(at("2026-03-05T00:00"));
    const next = cycle(first.cursor);

    expect(next.last.deletedExternalIds).toEqual(["call-log:2026-03-04"]);
    expect(next.last.documents).toEqual([]);
    expect(records(next.last).presentKeys).toEqual([{ id: String(kept) }]);
    expect(Object.keys(next.cursor!.groups)).toEqual(["2026-03-06"]);
  });

  it("pages a long history and sends presence only on the last page", () => {
    const db = fx.calls();
    for (let day = 0; day < 130; day++) {
      addCall(db, {
        number: PEER,
        direction: "in",
        outcome: "answered",
        startedAt: Date.UTC(2025, 0, 1 + day, 12),
        duration: 10,
      });
    }

    const { pages, cursor } = cycle(null);

    expect(pages).toHaveLength(2);
    expect(pages[0]!.documents).toHaveLength(100);
    expect(records(pages[0]!).presentKeys).toBeUndefined();
    expect(pages[0]!.issues).toBeUndefined();
    expect(pages[1]!.documents).toHaveLength(30);
    expect(records(pages[1]!).presentKeys).toHaveLength(130);
    expect(Object.keys(cursor!.groups)).toHaveLength(130);
  });

  it("reads nothing before the data cutoff", () => {
    const db = fx.calls();
    addCall(db, {
      number: PEER,
      direction: "in",
      outcome: "answered",
      startedAt: at("2026-03-04T09:15"),
      duration: 5,
    });
    addCall(db, {
      number: PEER,
      direction: "in",
      outcome: "answered",
      startedAt: at("2026-03-04T12:00"),
      duration: 5,
    });

    const { last } = cycle(null, { dataCutoff: "2026-03-04T10:00:00.000Z" });

    expect(last.documents![0]!.metadata.extra).toMatchObject({ callCount: 1 });
    expect(records(last).records).toHaveLength(1);
    expect(last.progress?.coverage).toBe("partial");
  });

  it("renders again every day when the rendering version changes", () => {
    addCall(fx.calls(), {
      number: PEER,
      direction: "in",
      outcome: "answered",
      startedAt: at("2026-03-04T09:15"),
    });
    const first = cycle(null);

    const next = cycle({ ...first.cursor!, render: 0 });

    expect(next.last.documents?.map((d) => d.externalId)).toEqual(["call-log:2026-03-04"]);
    expect(next.last.deletedExternalIds).toEqual([]);
  });

  it("treats a phone that has never placed a call as empty, without asserting it", () => {
    const { last } = cycle(null);

    expect(last.documents).toEqual([]);
    expect(last.deletedExternalIds).toEqual([]);
    expect(last.hasMore).toBe(false);
    expect(tableWrites(last.analytics)).toEqual([]);
    expect(last.issues).toEqual([]);
    expect(last.progress).toMatchObject({ percentComplete: 100 });
  });

  describe("after bootstrap, a calls.db that cannot be read", () => {
    const bootstrap = () => {
      const db = fx.calls();
      addCall(db, {
        number: PEER,
        direction: "in",
        outcome: "missed",
        startedAt: at("2026-03-04T09:15"),
      });
      addCall(db, {
        number: OTHER,
        direction: "out",
        outcome: "answered",
        startedAt: at("2026-03-05T10:00"),
        duration: 42,
      });
      return cycle(null).cursor;
    };

    /** The store reads again: nothing re-renders, nothing is deleted, every call is named. */
    const expectRestored = (cursor: OmatelCursor) => {
      const back = cycle(cursor);
      expect(back.last.documents).toEqual([]);
      expect(back.last.deletedExternalIds).toEqual([]);
      expect(records(back.last).presentKeys).toEqual([{ id: "1" }, { id: "2" }]);
      expect(back.last.issues).toEqual([]);
      expect(back.cursor).toEqual(cursor);
    };

    it.each([
      ["the file is replaced", "calls.db" as const],
      ["its folder is moved", undefined],
    ])("deletes nothing and keeps the cursor while %s, then picks up where it was", (_, file) => {
      const cursor = bootstrap();
      const restore = fx.hide(file);

      const gone = cycle(cursor);

      expect(gone.pages).toHaveLength(1);
      expect(gone.last.documents).toEqual([]);
      expect(gone.last.deletedExternalIds).toEqual([]);
      expect(tableWrites(gone.last.analytics)).toEqual([]);
      expect(gone.last.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
      expect(gone.cursor).toEqual(cursor);

      restore();
      expectRestored(cursor);
    });

    it.skipIf(process.getuid?.() === 0)(
      "fails the page as a permission problem when its folder may not be searched",
      () => {
        const cursor = bootstrap();
        chmodSync(fx.dir, 0o000);
        try {
          expect(() => syncCalls(cursor, options())).toThrow(/for reading \(EACCES\)/);
        } finally {
          chmodSync(fx.dir, 0o700);
        }
        expectRestored(cursor);
      },
    );
  });

  it("normalizes a national number with the phone's region, and keeps one it cannot parse", () => {
    const rows: CallRow[] = [
      {
        id: 1,
        number: "07700 000000",
        raw_number: "07700 000000",
        direction: "in",
        outcome: "answered",
        started_at: at("2026-03-04T09:15"),
        duration: 1,
      },
      {
        id: 2,
        number: "",
        raw_number: "BANK",
        direction: "in",
        outcome: "missed",
        started_at: at("2026-03-04T10:00"),
        duration: 0,
      },
    ];

    const doc = buildCallDay("2026-03-04", rows, {
      sourceId: callsSourceId,
      providerId,
      phoneRegion: "GB",
    });

    expect(doc.metadata.people).toContainEqual({ role: "participant", phones: ["+447700000000"] });
    expect(doc.content).toContain("- 10:00 Incoming call ← BANK (missed)");
    expect(doc.metadata.people).toHaveLength(2);
  });
});
