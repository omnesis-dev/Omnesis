// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
type Db = Database.Database;
import { SourceId, ProviderId, SyncError } from "@omnesis/types";
import { rowsFor, tablesWritten } from "@omnesis/source-sdk/testing";
import { coreDataToISO, coreDataToDate, appNameFromBundleId } from "./types.js";
import { aggregateDaily } from "./aggregator.js";
import definition from "./index.js";
import type { UsageSession } from "./types.js";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Screen Time provider definition", () => {
  test("declares macOS-only via supportedPlatforms", () => {
    // Screen Time reads ~/Library/Application Support/Knowledge/knowledgeC.db
    // which only exists on macOS.
    expect(definition.supportedPlatforms).toEqual(["darwin"]);
  });
});

// Create a temporary knowledgeC.db with test data
function createTestDb(dir: string): string {
  const dbPath = join(dir, "knowledgeC.db");
  const db = new Database(dbPath);

  db.prepare(
    `
    CREATE TABLE ZOBJECT (
      Z_PK INTEGER PRIMARY KEY,
      ZSTREAMNAME VARCHAR,
      ZVALUESTRING VARCHAR,
      ZSTARTDATE TIMESTAMP,
      ZENDDATE TIMESTAMP,
      ZCREATIONDATE TIMESTAMP,
      ZSECONDSFROMGMT INTEGER DEFAULT 0
    )
  `,
  ).run();

  // Insert test app usage sessions
  // Core Data epoch: 2001-01-01. We'll use timestamps for 2026-03-10
  // 2026-03-10 00:00:00 UTC = 793929600 seconds since 2001-01-01
  const march10 = 794793600;

  const sessions = [
    // Chrome: 30min session starting at 10:00
    {
      pk: 1,
      bundle: "com.google.Chrome",
      start: march10 + 36000,
      end: march10 + 37800,
      created: march10 + 37800,
    },
    // Chrome: 15min session starting at 14:00
    {
      pk: 2,
      bundle: "com.google.Chrome",
      start: march10 + 50400,
      end: march10 + 51300,
      created: march10 + 51300,
    },
    // iTerm2: 45min session starting at 11:00
    {
      pk: 3,
      bundle: "com.googlecode.iterm2",
      start: march10 + 39600,
      end: march10 + 42300,
      created: march10 + 42300,
    },
    // Safari: 10min session starting at 15:00
    {
      pk: 4,
      bundle: "com.apple.Safari",
      start: march10 + 54000,
      end: march10 + 54600,
      created: march10 + 54600,
    },
    // Next day (March 11): Chrome 20min
    {
      pk: 5,
      bundle: "com.google.Chrome",
      start: march10 + 86400 + 36000,
      end: march10 + 86400 + 37200,
      created: march10 + 86400 + 37200,
    },
  ];

  const stmt = db.prepare(
    "INSERT INTO ZOBJECT (Z_PK, ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE, ZCREATIONDATE) VALUES (?, '/app/usage', ?, ?, ?, ?)",
  );

  for (const s of sessions) {
    stmt.run(s.pk, s.bundle, s.start, s.end, s.created);
  }

  // Also insert a non-usage row to verify filtering
  db.prepare(
    "INSERT INTO ZOBJECT (Z_PK, ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE, ZCREATIONDATE) VALUES (100, '/display/isBacklit', NULL, ?, ?, ?)",
  ).run(march10, march10 + 100, march10 + 100);

  db.close();
  return dbPath;
}

describe("Screen Time types", () => {
  test("coreDataToISO converts correctly", () => {
    // 2001-01-01 00:00:00 UTC = Core Data 0
    expect(coreDataToISO(0)).toBe("2001-01-01T00:00:00.000Z");
    // 2026-03-10 00:00:00 UTC
    const march10 = 794793600;
    expect(coreDataToISO(march10)).toContain("2026-03-10");
  });

  test("coreDataToDate extracts date", () => {
    const march10 = 794793600;
    expect(coreDataToDate(march10)).toBe("2026-03-10");
  });

  test("appNameFromBundleId extracts last component", () => {
    expect(appNameFromBundleId("com.google.Chrome")).toBe("Chrome");
    expect(appNameFromBundleId("com.apple.Safari")).toBe("Safari");
    expect(appNameFromBundleId("com.googlecode.iterm2")).toBe("iterm2");
  });
});

describe("Screen Time aggregator", () => {
  const march10 = 794793600;

  test("aggregates sessions by app and date", () => {
    const sessions: UsageSession[] = [
      {
        pk: 1,
        bundleId: "com.google.Chrome",
        startDate: march10 + 36000,
        endDate: march10 + 37800,
        creationDate: march10 + 37800,
        durationSeconds: 1800,
      },
      {
        pk: 2,
        bundleId: "com.google.Chrome",
        startDate: march10 + 50400,
        endDate: march10 + 51300,
        creationDate: march10 + 51300,
        durationSeconds: 900,
      },
      {
        pk: 3,
        bundleId: "com.apple.Safari",
        startDate: march10 + 54000,
        endDate: march10 + 54600,
        creationDate: march10 + 54600,
        durationSeconds: 600,
      },
    ];

    const daily = aggregateDaily(sessions);
    expect(daily).toHaveLength(2); // Chrome + Safari

    const chrome = daily.find((d) => d.bundle_id === "com.google.Chrome");
    expect(chrome).toBeDefined();
    expect(chrome!.total_seconds).toBe(2700); // 1800 + 900
    expect(chrome!.session_count).toBe(2);
    expect(chrome!.longest_session_seconds).toBe(1800);

    const safari = daily.find((d) => d.bundle_id === "com.apple.Safari");
    expect(safari).toBeDefined();
    expect(safari!.total_seconds).toBe(600);
    expect(safari!.session_count).toBe(1);
  });

  test("filters by date set when provided", () => {
    const sessions: UsageSession[] = [
      {
        pk: 1,
        bundleId: "com.google.Chrome",
        startDate: march10,
        endDate: march10 + 1800,
        creationDate: march10 + 1800,
        durationSeconds: 1800,
      },
      {
        pk: 2,
        bundleId: "com.google.Chrome",
        startDate: march10 + 86400,
        endDate: march10 + 86400 + 1800,
        creationDate: march10 + 86400 + 1800,
        durationSeconds: 1800,
      },
    ];

    const daily = aggregateDaily(sessions, new Set(["2026-03-10"]));
    expect(daily).toHaveLength(1);
    expect(daily[0]!.date).toBe("2026-03-10");
  });
});

describe("Screen Time definition", () => {
  test("definition metadata", () => {
    expect(definition.id).toBe("screen-time");
    expect(definition.name).toBe("Screen Time");
    expect(definition.authType).toBe("local");
    expect(definition.singleInstance).toBe(true);
    expect(definition.multiDevice?.mode).toBe("partitioned");
    expect(definition.analyticsSchemas).toHaveLength(2);
    expect(definition.analyticsSchemas![0]!.tableName).toBe("screen_time_sessions");
    expect(definition.analyticsSchemas![1]!.tableName).toBe("screen_time_daily");
    expect(definition.icon).toBeDefined();
    expect(definition.icon!.sfSymbol).toBe("hourglass");
  });

  test("definition type is source", () => {
    expect(definition.type).toBe("source");
  });
});

describe("Screen Time source", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-screen-time-test-"));
    dbPath = createTestDb(tmpDir);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createInstance() {
    return definition.create!({
      accountId: "local",
      sourceId: SourceId("screen-time:local"),
      providerId: ProviderId("screen-time:local"),
      config: { dbPath },
    });
  }

  test("instance has analyticsSchemas", async () => {
    const instance = await createInstance();
    expect(instance.analyticsSchemas).toHaveLength(2);
    expect(instance.analyticsSchemas![0]!.tableName).toBe("screen_time_sessions");
    expect(instance.analyticsSchemas![1]!.tableName).toBe("screen_time_daily");
  });

  test("instance has watchPaths", async () => {
    const instance = await createInstance();
    expect(instance.watchPaths).toHaveLength(2);
    expect(instance.watchPaths![0]).toBe(dbPath);
    expect(instance.watchPaths![1]).toBe(`${dbPath}-wal`);
  });

  test("instance has syncStructured", async () => {
    const instance = await createInstance();
    expect(instance.syncStructured).toBeDefined();
    expect(typeof instance.syncStructured).toBe("function");
  });

  test("sync() returns empty (unstructured no-op)", async () => {
    const instance = await createInstance();
    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  test("full syncStructured cycle", async () => {
    const instance = await createInstance();

    // First call -- should return sessions
    let result = await instance.syncStructured!(null);
    expect(tablesWritten(result)).toEqual(["screen_time_sessions"]);
    expect(rowsFor(result, "screen_time_sessions").length).toBe(5);
    expect(result.hasMore).toBe(true);

    // Sessions are done -- cursor should have moved to "daily"
    const cursor = result.cursor as Record<string, unknown>;
    expect(cursor.phase).toBe("daily");

    // Second call -- should return daily aggregates
    result = await instance.syncStructured!(result.cursor);
    expect(tablesWritten(result)).toEqual(["screen_time_daily"]);
    expect(rowsFor(result, "screen_time_daily").length).toBeGreaterThan(0);
    expect(result.hasMore).toBe(false);

    // Verify daily aggregation
    const chromeDay1 = rowsFor(result, "screen_time_daily").find(
      (r) => r.bundle_id === "com.google.Chrome" && r.date === "2026-03-10",
    );
    expect(chromeDay1).toBeDefined();
    expect(chromeDay1!.total_seconds).toBe(2700); // 30min + 15min
    expect(chromeDay1!.session_count).toBe(2);

    // Verify done state
    const doneCursor = result.cursor as Record<string, unknown>;
    expect(doneCursor.phase).toBe("done");

    // Calling sync again with done cursor re-enters sessions phase
    // to check for new data (incremental sync)
    result = await instance.syncStructured!(result.cursor);
    expect(tablesWritten(result)).toHaveLength(0);
    expect(result.hasMore).toBe(true); // continues through phases even with no new data
  });

  test("reports coverage: unknown — the knowledge store's retention window is opaque to this source", async () => {
    const instance = await createInstance();

    // Bootstrap progress carries the caveat: knowledgeC.db is a rolling
    // store the OS prunes on its own schedule, so a fresh install cannot
    // tell whether the earliest row it sees is day-one or a pruning survivor.
    let result = await instance.syncStructured!(null);
    expect(result.progress?.coverage).toBe("unknown");

    // The terminal "aggregate" progress that closes out every round
    // (bootstrap or incremental) carries it too — the caveat doesn't
    // resolve once bootstrap finishes, it's a permanent property of the store.
    result = await instance.syncStructured!(result.cursor);
    expect(result.progress?.coverage).toBe("unknown");

    // A quiet round — the store gained nothing since the last one, so there
    // are no dates to aggregate — closes the same way. Saying nothing here
    // would leave `coverage` absent, which a client reads as the question
    // not applying to this source rather than as an unanswered one.
    result = await instance.syncStructured!(result.cursor); // re-enters "sessions", finds nothing
    expect(tablesWritten(result)).toHaveLength(0);
    result = await instance.syncStructured!(result.cursor); // "daily" with no affected dates
    expect(result.hasMore).toBe(false);
    expect(result.progress?.coverage).toBe("unknown");
  });

  test("incremental sync picks up new records", async () => {
    const instance = await createInstance();

    // Full initial sync
    let result = await instance.syncStructured!(null);
    expect(rowsFor(result, "screen_time_sessions").length).toBe(5);

    // Advance to daily
    result = await instance.syncStructured!(result.cursor);
    expect(tablesWritten(result)).toEqual(["screen_time_daily"]);

    // Now add a new session to the DB
    const db = new Database(dbPath);
    const march10 = 794793600;
    db.prepare(
      "INSERT INTO ZOBJECT (Z_PK, ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE, ZCREATIONDATE) VALUES (200, '/app/usage', 'com.apple.Notes', ?, ?, ?)",
    ).run(march10 + 172800, march10 + 172800 + 600, march10 + 172800 + 600);
    db.close();

    // Create a new instance (simulates next sync cycle)
    const instance2 = await createInstance();

    // Incremental sync with cursor from the "done" phase but reset to sessions
    const incrementalCursor = {
      phase: "sessions" as const,
      lastCreationDate: (result.cursor as Record<string, unknown>).lastCreationDate as number,
      lastPk: (result.cursor as Record<string, unknown>).lastPk as number,
      sessionsProcessed: 0,
      affectedDates: [],
    };

    result = await instance2.syncStructured!(incrementalCursor);
    expect(tablesWritten(result)).toEqual(["screen_time_sessions"]);
    const sessionRows = rowsFor(result, "screen_time_sessions");
    expect(sessionRows.length).toBe(1);
    expect(sessionRows[0]!.bundle_id).toBe("com.apple.Notes");
  });

  test("daily rollup sums sessions across incremental cycles on the same date", async () => {
    // Regression: syncDaily must re-aggregate the whole affected day from
    // the DB, not just the sessions read this cycle. The daily row is
    // upserted by `${bundle_id}:${date}` with REPLACE semantics, so a
    // second cycle that aggregated only its own freshly-read session would
    // clobber the first cycle's total (undercount).
    const cycleDir = mkdtempSync(join(tmpdir(), "omnesis-screen-time-rollup-"));
    try {
      const rollupDbPath = join(cycleDir, "knowledgeC.db");
      const db = new Database(rollupDbPath);
      db.prepare(
        `CREATE TABLE ZOBJECT (
          Z_PK INTEGER PRIMARY KEY,
          ZSTREAMNAME VARCHAR,
          ZVALUESTRING VARCHAR,
          ZSTARTDATE TIMESTAMP,
          ZENDDATE TIMESTAMP,
          ZCREATIONDATE TIMESTAMP
        )`,
      ).run();
      const insert = db.prepare(
        "INSERT INTO ZOBJECT (Z_PK, ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE, ZCREATIONDATE) VALUES (?, '/app/usage', ?, ?, ?, ?)",
      );

      const march10 = 794793600; // 2026-03-10 00:00:00 UTC in Core Data seconds
      // Cycle 1's session: 30min Chrome session in the morning.
      insert.run(1, "com.google.Chrome", march10 + 36000, march10 + 37800, march10 + 37800);
      db.close();

      const instance = await definition.create!({
        accountId: "local",
        sourceId: SourceId("screen-time:local"),
        providerId: ProviderId("screen-time:local"),
        config: { dbPath: rollupDbPath },
      });

      // --- Cycle 1: sessions -> daily ---
      let result = await instance.syncStructured!(null);
      expect(tablesWritten(result)).toEqual(["screen_time_sessions"]);
      result = await instance.syncStructured!(result.cursor);
      expect(tablesWritten(result)).toEqual(["screen_time_daily"]);

      let chromeDay = rowsFor(result, "screen_time_daily").find(
        (r) => r.bundle_id === "com.google.Chrome" && r.date === "2026-03-10",
      );
      expect(chromeDay).toBeDefined();
      expect(chromeDay!.total_seconds).toBe(1800);
      expect(chromeDay!.session_count).toBe(1);

      // A second Chrome session arrives later the SAME day, with a larger
      // ZCREATIONDATE so it's only visible to cycle 2.
      const db2 = new Database(rollupDbPath);
      db2
        .prepare(
          "INSERT INTO ZOBJECT (Z_PK, ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE, ZCREATIONDATE) VALUES (2, '/app/usage', 'com.google.Chrome', ?, ?, ?)",
        )
        .run(march10 + 50400, march10 + 51300, march10 + 51300); // 15min session
      db2.close();

      // --- Cycle 2: done -> sessions -> daily ---
      result = await instance.syncStructured!(result.cursor); // done -> sessions
      expect(tablesWritten(result)).toEqual(["screen_time_sessions"]);
      expect(rowsFor(result, "screen_time_sessions").length).toBe(1);
      result = await instance.syncStructured!(result.cursor); // sessions -> daily
      expect(tablesWritten(result)).toEqual(["screen_time_daily"]);

      chromeDay = rowsFor(result, "screen_time_daily").find(
        (r) => r.bundle_id === "com.google.Chrome" && r.date === "2026-03-10",
      );
      expect(chromeDay).toBeDefined();
      // Daily total must reflect BOTH sessions (1800 + 900), not just cycle 2's.
      expect(chromeDay!.total_seconds).toBe(2700);
      expect(chromeDay!.session_count).toBe(2);
      expect(chromeDay!.longest_session_seconds).toBe(1800);
    } finally {
      rmSync(cycleDir, { recursive: true, force: true });
    }
  });

  test("session records have correct fields", async () => {
    const instance = await createInstance();

    const result = await instance.syncStructured!(null);
    const record = rowsFor(result, "screen_time_sessions")[0]!;

    expect(record).toHaveProperty("id");
    expect(record).toHaveProperty("bundle_id");
    expect(record).toHaveProperty("app_name");
    expect(record).toHaveProperty("start_time");
    expect(record).toHaveProperty("end_time");
    expect(record).toHaveProperty("duration_seconds");
    expect(record).toHaveProperty("date");
    expect(record).toHaveProperty("day_of_week");

    // Verify types
    expect(typeof record.id).toBe("string");
    expect(typeof record.bundle_id).toBe("string");
    expect(typeof record.duration_seconds).toBe("number");
    expect(typeof record.day_of_week).toBe("number");
  });
});

describe("KnowledgeDbReader", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-screen-time-reader-test-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Build a minimal knowledgeC.db with the columns the source needs.
  function makeDbWith(
    rows: Array<{
      pk: number;
      stream: string;
      bundle: string | null;
      start: number;
      end: number;
      created: number;
    }>,
  ): string {
    const dbPath = join(dir, `db-${Math.random().toString(36).slice(2)}.db`);
    const db = new Database(dbPath);
    db.prepare(
      `CREATE TABLE ZOBJECT (
      Z_PK INTEGER PRIMARY KEY,
      ZSTREAMNAME VARCHAR,
      ZVALUESTRING VARCHAR,
      ZSTARTDATE TIMESTAMP,
      ZENDDATE TIMESTAMP,
      ZCREATIONDATE TIMESTAMP
    )`,
    ).run();
    const ins = db.prepare(
      "INSERT INTO ZOBJECT (Z_PK, ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE, ZCREATIONDATE) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const r of rows) ins.run(r.pk, r.stream, r.bundle, r.start, r.end, r.created);
    db.close();
    return dbPath;
  }

  test("snapshot-copy lets two readers open the same DB concurrently", async () => {
    const { KnowledgeDbReader } = await import("./db-reader.js");
    const dbPath = makeDbWith([
      { pk: 1, stream: "/app/usage", bundle: "com.apple.Safari", start: 1, end: 2, created: 2 },
    ]);
    const r1 = new KnowledgeDbReader(dbPath);
    const r2 = new KnowledgeDbReader(dbPath);
    expect(r1.fetchSessions(0, 0, 10).sessions.length).toBe(1);
    expect(r2.fetchSessions(0, 0, 10).sessions.length).toBe(1);
    r1.close();
    r2.close();
  });

  test("countSessions caches across calls", async () => {
    const { KnowledgeDbReader } = await import("./db-reader.js");
    const dbPath = makeDbWith([
      { pk: 1, stream: "/app/usage", bundle: "a", start: 1, end: 2, created: 2 },
      { pk: 2, stream: "/app/usage", bundle: "b", start: 3, end: 4, created: 4 },
    ]);
    const reader = new KnowledgeDbReader(dbPath);
    expect(reader.countSessions()).toBe(2);
    // Insert a third row directly into the live DB. Snapshot already
    // taken, so the cached count stays at 2.
    const live = new Database(dbPath);
    live
      .prepare(
        "INSERT INTO ZOBJECT (Z_PK, ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE, ZCREATIONDATE) VALUES (3, '/app/usage', 'c', 5, 6, 6)",
      )
      .run();
    live.close();
    expect(reader.countSessions()).toBe(2);
    reader.close();
  });

  test("fetchSessions filters negative + >24h durations and reports the count", async () => {
    const { KnowledgeDbReader } = await import("./db-reader.js");
    const dbPath = makeDbWith([
      { pk: 1, stream: "/app/usage", bundle: "ok", start: 100, end: 200, created: 200 },
      // Negative duration — corrupt CoreData row.
      { pk: 2, stream: "/app/usage", bundle: "neg", start: 200, end: 100, created: 200 },
      // >24h duration — sleep / clock-skew artefact.
      { pk: 3, stream: "/app/usage", bundle: "huge", start: 0, end: 86401, created: 86401 },
    ]);
    const reader = new KnowledgeDbReader(dbPath);
    const { sessions, invalidDurationCount } = reader.fetchSessions(0, 0, 100);
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.bundleId).toBe("ok");
    expect(invalidDurationCount).toBe(2);
    reader.close();
  });

  test("paginates across rows sharing the boundary ZCREATIONDATE without dropping any", async () => {
    const { KnowledgeDbReader } = await import("./db-reader.js");
    // Three rows where pk=2 and pk=3 share the identical creationDate 200,
    // straddling a LIMIT=2 page boundary. Paging on ZCREATIONDATE alone with a
    // strict `>` would advance the cursor to 200 after page 1 and then skip
    // pk=3 forever (WHERE ZCREATIONDATE > 200). The (creationDate, Z_PK)
    // composite cursor must still return pk=3 on the second page.
    const dbPath = makeDbWith([
      { pk: 1, stream: "/app/usage", bundle: "a", start: 100, end: 200, created: 100 },
      { pk: 2, stream: "/app/usage", bundle: "b", start: 100, end: 200, created: 200 },
      { pk: 3, stream: "/app/usage", bundle: "c", start: 100, end: 200, created: 200 },
    ]);
    const reader = new KnowledgeDbReader(dbPath);

    // Page 1: first two rows, ordered by (creationDate, pk).
    const page1 = reader.fetchSessions(0, 0, 2);
    expect(page1.sessions.map((s) => s.pk)).toEqual([1, 2]);

    // Advance the cursor exactly as the source does — to the last emitted row.
    const last = page1.sessions[page1.sessions.length - 1]!;

    // Page 2: must yield the boundary-sharing row pk=3, not zero rows.
    const page2 = reader.fetchSessions(last.creationDate, last.pk, 2);
    expect(page2.sessions.map((s) => s.pk)).toEqual([3]);

    // No row is lost or duplicated across the two pages.
    const allPks = [...page1.sessions, ...page2.sessions].map((s) => s.pk).sort();
    expect(allPks).toEqual([1, 2, 3]);

    reader.close();
  });

  test("schema probe disables the source on a missing column", async () => {
    const { KnowledgeDbReader } = await import("./db-reader.js");
    // Build a DB that's missing ZVALUESTRING — simulate a future macOS
    // schema rename.
    const dbPath = join(dir, `bad-schema-${Math.random().toString(36).slice(2)}.db`);
    const db = new Database(dbPath);
    db.prepare(
      `CREATE TABLE ZOBJECT (
      Z_PK INTEGER PRIMARY KEY,
      ZSTREAMNAME VARCHAR,
      ZSTARTDATE TIMESTAMP,
      ZENDDATE TIMESTAMP,
      ZCREATIONDATE TIMESTAMP
    )`,
    ).run();
    db.close();

    const reader = new KnowledgeDbReader(dbPath);
    expect(reader.schemaOk).toBe(false);
    // Behaviour: degrade-and-warn. fetchSessions returns empty rather than throwing.
    const { sessions, invalidDurationCount } = reader.fetchSessions(0, 0, 100);
    expect(sessions).toEqual([]);
    expect(invalidDurationCount).toBe(0);
    expect(reader.countSessions()).toBe(0);
    reader.close();
  });

  test("a store whose layout is unrecognised says so, rather than blaming macOS pruning", async () => {
    // The reader answers every query with nothing and raises no error, so the
    // cycle closes at 100% having read the store and taken none of it. Saying
    // "unknown" there — with the rolling-window sentence — explains an empty
    // read as macOS having pruned, which is a true statement about the store
    // in general and a false one about what just happened.
    const badPath = join(dir, `unreadable-${Math.random().toString(36).slice(2)}.db`);
    const db = new Database(badPath);
    db.prepare(
      `CREATE TABLE ZOBJECT (
        Z_PK INTEGER PRIMARY KEY,
        ZSTREAMNAME VARCHAR,
        ZSTARTDATE TIMESTAMP,
        ZENDDATE TIMESTAMP,
        ZCREATIONDATE TIMESTAMP
      )`,
    ).run();
    db.close();

    const instance = await definition.create!({
      accountId: "local",
      sourceId: SourceId("screen-time:local"),
      providerId: ProviderId("screen-time:local"),
      config: { dbPath: badPath },
    });

    // Walk the whole cycle: the sessions phase is where the schema is known,
    // and the daily phase is where the cycle closes and speaks.
    let cursor = null as unknown;
    let last;
    for (let i = 0; i < 4; i++) {
      last = await instance.syncStructured!(cursor as never);
      cursor = last.cursor;
      if (!last.hasMore) break;
    }
    expect(last!.progress?.coverage).toBe("partial");
    expect(last!.progress?.detail).toMatch(/does not recognise/i);
  });

  // Screen Time is the only source on its connection, so a denial stops this
  // source and names nothing beyond it: the scope stays at the default.
  test("an unreadable knowledgeC.db raises a permission SyncError scoped to the source, with full-disk access remediation", async () => {
    const { KnowledgeDbReader } = await import("./db-reader.js");
    const dbPath = makeDbWith([
      { pk: 1, stream: "/app/usage", bundle: "a", start: 1, end: 2, created: 2 },
    ]);
    chmodSync(dbPath, 0o000);
    try {
      expect(() => new KnowledgeDbReader(dbPath)).toThrow(SyncError);
      try {
        new KnowledgeDbReader(dbPath);
        expect.unreachable("expected KnowledgeDbReader to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SyncError);
        const syncErr = err as SyncError;
        expect(syncErr.kind).toBe("permission");
        expect(syncErr.scope).toBe("source");
        expect(syncErr.remediation?.executable).toBe(process.execPath);
      }
    } finally {
      chmodSync(dbPath, 0o600);
    }
  });
});

describe("coreDataToUtcWeekday", () => {
  test("matches coreDataToDate's UTC anchor", async () => {
    const { coreDataToUtcWeekday, coreDataToDate, CORE_DATA_EPOCH } = await import("./types.js");
    // 2026-03-10 00:00:00 UTC is a Tuesday (= weekday 2).
    const march10 = 794793600;
    expect(coreDataToDate(march10)).toBe("2026-03-10");
    expect(coreDataToUtcWeekday(march10)).toBe(2);
    expect(CORE_DATA_EPOCH).toBe(978307200);
  });
});
