// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
type Db = Database.Database;
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SourceId, ProviderId, SyncError } from "@omnesis/types";
import { rowsFor, tablesWritten } from "@omnesis/source-sdk/testing";

// Mutable holder so the (hoisted) ./paths.js mock can be pointed at a
// per-test temp directory created in beforeAll. getBrowserInfo otherwise
// resolves an OS-specific install path, so driving the real syncStructured
// phase machine against a fixture DB requires overriding it.
const browserInfoMock = vi.hoisted(() => ({ baseDir: "" }));

vi.mock("./paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths.js")>();
  const info = (id: string) => ({
    id,
    name: "Google Chrome",
    baseDir: browserInfoMock.baseDir,
    engine: "chromium" as const,
  });
  return {
    ...actual,
    getBrowserInfo: (id: string) => (browserInfoMock.baseDir ? info(id) : null),
    detectInstalledBrowsers: () => (browserInfoMock.baseDir ? [info("chrome")] : []),
  };
});

import { webPageEdgeTarget } from "@omnesis/core";
import { mapTransitionType, extractDomain, shouldIncludeVisit } from "./filters.js";
import {
  chromiumTimestampToMs,
  msToChromiumTimestamp,
  discoverProfiles,
  ChromiumHistoryReader,
} from "./readers/chromium.js";
import { safariTimestampToMs, msToSafariTimestamp, SafariHistoryReader } from "./readers/safari.js";
import { aggregateDaily } from "./aggregator.js";
import { buildDailyDocument, buildDailyEdges } from "./normalizer.js";
import definition from "./index.js";
import type { RawVisit, BrowserHistoryCursor } from "./types.js";
import type { SyncProgress } from "@omnesis/source-sdk";

test("Browser History remains exclusive while local and Chrome-synced visits can overlap", () => {
  expect(definition.multiDevice).toBeUndefined();
});

// ── Test timestamps ──
// 2026-04-16 10:00:00 UTC
const APRIL_16_10AM_MS = new Date("2026-04-16T10:00:00.000Z").getTime();
const APRIL_16_10AM_CHROMIUM = msToChromiumTimestamp(APRIL_16_10AM_MS);
const APRIL_16_10AM_SAFARI = msToSafariTimestamp(APRIL_16_10AM_MS);

// 2026-04-16 14:30:00 UTC
const APRIL_16_230PM_MS = new Date("2026-04-16T14:30:00.000Z").getTime();
const APRIL_16_230PM_CHROMIUM = msToChromiumTimestamp(APRIL_16_230PM_MS);

// 2026-04-17 09:00:00 UTC (next day)
const APRIL_17_9AM_MS = new Date("2026-04-17T09:00:00.000Z").getTime();
const APRIL_17_9AM_CHROMIUM = msToChromiumTimestamp(APRIL_17_9AM_MS);

// ── Helpers: Create mock databases ──

function createChromiumDb(dir: string, profileDir = "Default", profileName = "Test User") {
  // Create Local State with profile info
  const localState = {
    profile: {
      info_cache: {
        [profileDir]: { name: profileName, user_name: "" },
      },
    },
  };
  writeFileSync(join(dir, "Local State"), JSON.stringify(localState));

  // Create profile directory and History database
  mkdirSync(join(dir, profileDir), { recursive: true });
  const dbPath = join(dir, profileDir, "History");
  const db = new Database(dbPath);

  db.prepare(
    `CREATE TABLE urls (
    id INTEGER PRIMARY KEY,
    url LONGVARCHAR,
    title LONGVARCHAR,
    visit_count INTEGER DEFAULT 0,
    typed_count INTEGER DEFAULT 0,
    last_visit_time INTEGER DEFAULT 0,
    hidden INTEGER DEFAULT 0
  )`,
  ).run();

  db.prepare(
    `CREATE TABLE visits (
    id INTEGER PRIMARY KEY,
    url INTEGER,
    visit_time INTEGER,
    from_visit INTEGER DEFAULT 0,
    transition INTEGER DEFAULT 0,
    visit_duration INTEGER DEFAULT 0,
    is_known_to_sync INTEGER DEFAULT 0,
    originator_cache_guid TEXT DEFAULT ''
  )`,
  ).run();

  db.prepare(
    `CREATE TABLE visit_source (
    id INTEGER,
    source INTEGER
  )`,
  ).run();

  db.prepare(
    `CREATE TABLE keyword_search_terms (
    keyword_id INTEGER,
    url_id INTEGER,
    term TEXT,
    normalized_term TEXT
  )`,
  ).run();

  return { db, dbPath };
}

function insertChromiumVisit(
  db: Db,
  urlId: number,
  visitId: number,
  url: string,
  title: string,
  visitTime: number,
  opts: {
    transition?: number;
    duration?: number;
    hidden?: boolean;
    synced?: boolean;
    originatorGuid?: string;
  } = {},
) {
  db.prepare(`INSERT OR IGNORE INTO urls (id, url, title, hidden) VALUES (?, ?, ?, ?)`).run(
    urlId,
    url,
    title,
    opts.hidden ? 1 : 0,
  );
  db.prepare(
    `INSERT INTO visits (id, url, visit_time, transition, visit_duration, originator_cache_guid) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    visitId,
    urlId,
    visitTime,
    opts.transition ?? 0,
    opts.duration ?? 0,
    opts.originatorGuid ?? "",
  );
  if (opts.synced) {
    db.prepare(`INSERT INTO visit_source (id, source) VALUES (?, 0)`).run(visitId);
  }
}

function createSafariDb(dir: string) {
  const dbPath = join(dir, "History.db");
  const db = new Database(dbPath);

  db.prepare(
    `CREATE TABLE history_items (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    visit_count INTEGER NOT NULL DEFAULT 0
  )`,
  ).run();

  db.prepare(
    `CREATE TABLE history_visits (
    id INTEGER PRIMARY KEY,
    history_item INTEGER NOT NULL,
    visit_time REAL NOT NULL,
    title TEXT,
    origin INTEGER NOT NULL DEFAULT 0
  )`,
  ).run();

  return { db, dbPath };
}

function insertSafariVisit(
  db: Db,
  itemId: number,
  visitId: number,
  url: string,
  title: string,
  visitTime: number,
  origin = 0,
) {
  db.prepare(`INSERT OR IGNORE INTO history_items (id, url) VALUES (?, ?)`).run(itemId, url);
  db.prepare(
    `INSERT INTO history_visits (id, history_item, visit_time, title, origin) VALUES (?, ?, ?, ?, ?)`,
  ).run(visitId, itemId, visitTime, title, origin);
}

// ── Tests ──

describe("Source definition metadata", () => {
  test("advertises a default search-score prior of -0.04", () => {
    // Browser history is bulky and low-signal relative to personal
    // documents; shipping a small additive downweight as a source
    // default lets the gateway boost-stage push it below an email or
    // note matching the same query out of the box. User
    // `search.sourcePriors.weights` in omnesis.json still overrides.
    expect(definition.defaultSourcePrior).toBe(-0.04);
  });
});

describe("Timestamp conversion", () => {
  test("chromiumTimestampToMs converts correctly", () => {
    const ms = chromiumTimestampToMs(APRIL_16_10AM_CHROMIUM);
    expect(ms).toBe(APRIL_16_10AM_MS);
  });

  test("msToChromiumTimestamp is inverse of chromiumTimestampToMs", () => {
    const chromium = msToChromiumTimestamp(APRIL_16_10AM_MS);
    const roundTrip = chromiumTimestampToMs(chromium);
    expect(roundTrip).toBe(APRIL_16_10AM_MS);
  });

  test("safariTimestampToMs converts correctly", () => {
    const ms = safariTimestampToMs(APRIL_16_10AM_SAFARI);
    expect(ms).toBe(APRIL_16_10AM_MS);
  });

  test("msToSafariTimestamp is inverse of safariTimestampToMs", () => {
    const safari = msToSafariTimestamp(APRIL_16_10AM_MS);
    const roundTrip = safariTimestampToMs(safari);
    expect(roundTrip).toBe(APRIL_16_10AM_MS);
  });
});

describe("Transition type mapping", () => {
  test("maps core types correctly", () => {
    expect(mapTransitionType(0)).toBe("link");
    expect(mapTransitionType(1)).toBe("typed");
    expect(mapTransitionType(2)).toBe("bookmark");
    expect(mapTransitionType(3)).toBe("auto_subframe");
    expect(mapTransitionType(7)).toBe("form_submit");
    expect(mapTransitionType(8)).toBe("reload");
    expect(mapTransitionType(9)).toBe("keyword");
    expect(mapTransitionType(10)).toBe("keyword_generated");
  });

  test("masks high bits to extract core type", () => {
    // Link (0) with FROM_ADDRESS_BAR flag (0x02000000)
    expect(mapTransitionType(0x02000000)).toBe("link");
    // Typed (1) with CHAIN_END flag (0x20000000)
    expect(mapTransitionType(0x20000001)).toBe("typed");
  });

  test("returns 'other' for unknown types", () => {
    expect(mapTransitionType(255)).toBe("other");
  });
});

describe("Domain extraction", () => {
  test("extracts canonical hostname from URLs (strips leading www.)", () => {
    expect(extractDomain("https://www.example.com/path?q=1")).toBe("example.com");
    expect(extractDomain("http://github.com")).toBe("github.com");
    expect(extractDomain("https://localhost:3000/api")).toBe("localhost");
  });

  test("returns empty string for invalid URLs", () => {
    expect(extractDomain("not-a-url")).toBe("");
    expect(extractDomain("")).toBe("");
  });
});

describe("Visit filtering", () => {
  const makeVisit = (overrides: Partial<RawVisit> = {}): RawVisit => {
    const url = overrides.url ?? "https://example.com";
    return {
      url,
      domain: overrides.domain ?? extractDomain(url),
      title: "Example",
      timestamp: APRIL_16_10AM_MS,
      isSynced: false,
      profile: "default",
      browser: "chrome",
      ...overrides,
    };
  };

  test("rejects internal browser URLs", () => {
    expect(shouldIncludeVisit(makeVisit({ url: "chrome://settings" }))).toBe(false);
    expect(shouldIncludeVisit(makeVisit({ url: "brave://extensions" }))).toBe(false);
    expect(shouldIncludeVisit(makeVisit({ url: "about:blank" }))).toBe(false);
    expect(shouldIncludeVisit(makeVisit({ url: "chrome-extension://abc/popup.html" }))).toBe(false);
    expect(
      shouldIncludeVisit(makeVisit({ url: "devtools://devtools/bundled/inspector.html" })),
    ).toBe(false);
  });

  test("rejects hidden URLs", () => {
    expect(shouldIncludeVisit(makeVisit({ hidden: true }))).toBe(false);
  });

  test("rejects subframe transitions", () => {
    expect(shouldIncludeVisit(makeVisit({ transitionRaw: 3 }))).toBe(false); // auto_subframe
    expect(shouldIncludeVisit(makeVisit({ transitionRaw: 4 }))).toBe(false); // manual_subframe
  });

  test("rejects redirect mid-chain", () => {
    // SERVER_REDIRECT (0x08000000) without CHAIN_END (0x20000000)
    expect(shouldIncludeVisit(makeVisit({ transitionRaw: 0x08000000 }))).toBe(false);
    // CLIENT_REDIRECT without CHAIN_END
    expect(shouldIncludeVisit(makeVisit({ transitionRaw: 0x10000000 }))).toBe(false);
  });

  test("accepts redirect chain end", () => {
    // SERVER_REDIRECT + CHAIN_END → this is the final destination, should be included
    expect(shouldIncludeVisit(makeVisit({ transitionRaw: 0x08000000 | 0x20000000 }))).toBe(true);
  });

  test("accepts normal visits", () => {
    expect(shouldIncludeVisit(makeVisit())).toBe(true);
    expect(shouldIncludeVisit(makeVisit({ transitionRaw: 0 }))).toBe(true); // link
    expect(shouldIncludeVisit(makeVisit({ transitionRaw: 1 }))).toBe(true); // typed
  });

  test("respects excludeDomains config", () => {
    const config = { excludeDomains: ["ads.example.com", "tracker.net"] };
    expect(shouldIncludeVisit(makeVisit({ url: "https://ads.example.com/pixel" }), config)).toBe(
      false,
    );
    expect(shouldIncludeVisit(makeVisit({ url: "https://sub.ads.example.com/x" }), config)).toBe(
      false,
    );
    expect(shouldIncludeVisit(makeVisit({ url: "https://example.com" }), config)).toBe(true);
  });

  test("respects excludeLocalhost config", () => {
    const config = { excludeLocalhost: true };
    expect(shouldIncludeVisit(makeVisit({ url: "http://localhost:3000" }), config)).toBe(false);
    expect(shouldIncludeVisit(makeVisit({ url: "http://127.0.0.1:8080" }), config)).toBe(false);
    expect(shouldIncludeVisit(makeVisit({ url: "https://example.com" }), config)).toBe(true);
  });

  test("respects excludeProfiles config", () => {
    const config = { excludeProfiles: ["Guest"] };
    expect(shouldIncludeVisit(makeVisit({ profile: "Guest" }), config)).toBe(false);
    expect(shouldIncludeVisit(makeVisit({ profile: "James" }), config)).toBe(true);
  });
});

describe("Profile discovery", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-test-profiles-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("discovers Chromium profiles from Local State", () => {
    const localState = {
      profile: {
        info_cache: {
          Default: { name: "James", user_name: "jamesbond@example.com" },
          "Profile 1": { name: "Work", user_name: "work@company.com" },
        },
      },
    };
    writeFileSync(join(tmpDir, "Local State"), JSON.stringify(localState));

    // Create History files so profiles are detected as valid
    mkdirSync(join(tmpDir, "Default"), { recursive: true });
    const db1 = new Database(join(tmpDir, "Default", "History"));
    db1.prepare("CREATE TABLE urls (id INTEGER)").run();
    db1.close();

    mkdirSync(join(tmpDir, "Profile 1"), { recursive: true });
    const db2 = new Database(join(tmpDir, "Profile 1", "History"));
    db2.prepare("CREATE TABLE urls (id INTEGER)").run();
    db2.close();

    const profiles = discoverProfiles(tmpDir);
    expect(profiles).toHaveLength(2);
    expect(profiles[0].name).toBe("jamesbond@example.com");
    expect(profiles[0].dir).toBe("Default");
    expect(profiles[1].name).toBe("work@company.com");
    expect(profiles[1].dir).toBe("Profile 1");
  });

  test("returns empty array when Local State missing", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "omnesis-test-noprofiles-"));
    try {
      expect(discoverProfiles(emptyDir)).toEqual([]);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("Chromium reader", () => {
  let tmpDir: string;
  let db: Db;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-test-chromium-"));
    const result = createChromiumDb(tmpDir);
    db = result.db;

    // Insert test visits
    insertChromiumVisit(db, 1, 1, "https://github.com", "GitHub", APRIL_16_10AM_CHROMIUM, {
      transition: 1,
      duration: 300_000_000,
    });
    insertChromiumVisit(
      db,
      2,
      2,
      "https://docs.rs/tokio",
      "Tokio Docs",
      APRIL_16_10AM_CHROMIUM + 1_000_000,
      { transition: 0 },
    );
    insertChromiumVisit(
      db,
      3,
      3,
      "https://stackoverflow.com/q/123",
      "SO Question",
      APRIL_16_230PM_CHROMIUM,
      { transition: 0, synced: true },
    );
    insertChromiumVisit(
      db,
      4,
      4,
      "https://example.com/next-day",
      "Next Day",
      APRIL_17_9AM_CHROMIUM,
    );

    // Insert a hidden URL (should be filtered)
    insertChromiumVisit(
      db,
      5,
      5,
      "https://hidden.com",
      "Hidden",
      APRIL_16_10AM_CHROMIUM + 2_000_000,
      { hidden: true },
    );

    // Insert a search term
    db.prepare(
      `INSERT INTO keyword_search_terms (keyword_id, url_id, term, normalized_term) VALUES (1, 3, 'rust error handling', 'rust error handling')`,
    ).run();

    db.close();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads visits in chronological order", () => {
    const reader = new ChromiumHistoryReader({
      id: "chrome",
      name: "Chrome",
      baseDir: tmpDir,
      engine: "chromium",
    });
    const { visits } = reader.readVisits({}, 0, 100);
    reader.close();

    // 5 total inserts but hidden one is still returned (filtering is done in index.ts)
    expect(visits.length).toBe(5);
    // URL is normalised at the reader boundary — root paths
    // keep their trailing slash, query+fragment are stripped/sorted, etc.
    expect(visits[0].url).toBe("https://github.com/");
    expect(visits[0].domain).toBe("github.com");
    expect(visits[0].transitionType).toBe("typed");
    expect(visits[0].visitDuration).toBe(300); // 300 seconds
    expect(visits[0].profile).toBe("Test User");

    // Verify timestamps are sorted
    for (let i = 1; i < visits.length; i++) {
      expect(visits[i].timestamp).toBeGreaterThanOrEqual(visits[i - 1].timestamp);
    }
  });

  test("detects synced visits via visit_source", () => {
    const reader = new ChromiumHistoryReader({
      id: "chrome",
      name: "Chrome",
      baseDir: tmpDir,
      engine: "chromium",
    });
    const { visits } = reader.readVisits({}, 0, 100);
    reader.close();

    const soVisit = visits.find((v) => v.url === "https://stackoverflow.com/q/123");
    expect(soVisit?.isSynced).toBe(true);

    const ghVisit = visits.find((v) => v.url === "https://github.com/");
    expect(ghVisit?.isSynced).toBe(false);
  });

  test("reads visits for a specific date", () => {
    const reader = new ChromiumHistoryReader({
      id: "chrome",
      name: "Chrome",
      baseDir: tmpDir,
      engine: "chromium",
    });
    const visits = reader.readVisitsForDate("2026-04-16");
    reader.close();

    // April 16 should have github, tokio, SO, and hidden — but NOT next day
    expect(visits.length).toBe(4);
    expect(visits.every((v) => v.url !== "https://example.com/next-day")).toBe(true);
  });

  test("reads search terms", () => {
    const reader = new ChromiumHistoryReader({
      id: "chrome",
      name: "Chrome",
      baseDir: tmpDir,
      engine: "chromium",
    });
    const { terms } = reader.readSearchTerms({}, 0, 100);
    reader.close();

    expect(terms.length).toBe(1);
    expect(terms[0].term).toBe("rust error handling");
    expect(terms[0].searchEngineDomain).toBe("stackoverflow.com");
  });

  test("returns correct watch paths", () => {
    const reader = new ChromiumHistoryReader({
      id: "chrome",
      name: "Chrome",
      baseDir: tmpDir,
      engine: "chromium",
    });
    const paths = reader.getWatchPaths();
    reader.close();

    expect(paths.length).toBe(2); // History + History-wal
    expect(paths[0]).toContain("Default/History");
    expect(paths[1]).toContain("Default/History-wal");
  });

  test("readDistinctVisitDates enumerates dates across all visits", () => {
    const reader = new ChromiumHistoryReader({
      id: "chrome",
      name: "Chrome",
      baseDir: tmpDir,
      engine: "chromium",
    });
    const { dates, partialFailure } = reader.readDistinctVisitDates();
    reader.close();

    expect(partialFailure).toBe(false);
    // Fixture has visits on April 16 and one on next day → 2 dates.
    expect(dates.sort()).toEqual(["2026-04-16", "2026-04-17"]);
  });

  test("readDistinctVisitDates returns partialFailure when no profiles discovered", () => {
    const reader = new ChromiumHistoryReader({
      id: "chrome",
      name: "Chrome",
      baseDir: "/nonexistent/dir",
      engine: "chromium",
    });
    const { dates, partialFailure } = reader.readDistinctVisitDates();
    reader.close();

    expect(dates).toEqual([]);
    expect(partialFailure).toBe(true);
  });
});

describe("Safari reader", () => {
  let tmpDir: string;
  let db: Db;
  let dbPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-test-safari-"));
    const result = createSafariDb(tmpDir);
    db = result.db;
    dbPath = result.dbPath;

    insertSafariVisit(db, 1, 1, "https://apple.com", "Apple", APRIL_16_10AM_SAFARI, 0);
    insertSafariVisit(
      db,
      2,
      2,
      "https://developer.apple.com/docs",
      "Dev Docs",
      APRIL_16_10AM_SAFARI + 600,
      0,
    );
    insertSafariVisit(
      db,
      3,
      3,
      "https://reddit.com/r/swift",
      "r/swift",
      APRIL_16_10AM_SAFARI + 1800,
      2,
    ); // synced from iPhone

    db.close();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads visits in chronological order", () => {
    const reader = SafariHistoryReader.withPath(dbPath);
    const { visits } = reader.readVisits({}, 0, 100);
    reader.close();

    expect(visits.length).toBe(3);
    // Normalised at the reader boundary.
    expect(visits[0].url).toBe("https://apple.com/");
    expect(visits[0].domain).toBe("apple.com");
    expect(visits[0].browser).toBe("safari");
    expect(visits[0].profile).toBe("default");
  });

  test("detects synced visits via origin field", () => {
    const reader = SafariHistoryReader.withPath(dbPath);
    const { visits } = reader.readVisits({}, 0, 100);
    reader.close();

    const localVisit = visits.find((v) => v.url === "https://apple.com/");
    expect(localVisit?.isSynced).toBe(false);

    const syncedVisit = visits.find((v) => v.url === "https://reddit.com/r/swift");
    expect(syncedVisit?.isSynced).toBe(true);
  });

  test("reads visits for a specific date", () => {
    const reader = SafariHistoryReader.withPath(dbPath);
    const visits = reader.readVisitsForDate("2026-04-16");
    reader.close();

    expect(visits.length).toBe(3);
  });

  test("returns empty search terms (not supported in Safari)", () => {
    const reader = SafariHistoryReader.withPath(dbPath);
    const { terms } = reader.readSearchTerms({}, 0, 100);
    reader.close();

    expect(terms).toEqual([]);
  });

  test("readDistinctVisitDates enumerates every UTC date with at least one visit", () => {
    const reader = SafariHistoryReader.withPath(dbPath);
    const { dates, partialFailure } = reader.readDistinctVisitDates();
    reader.close();

    // 3 visits all on 2026-04-16 → distinct yields one date.
    expect(partialFailure).toBe(false);
    expect(dates).toEqual(["2026-04-16"]);
  });

  test("readDistinctVisitDates signals partialFailure when DB is missing", () => {
    const reader = SafariHistoryReader.withPath(join(tmpDir, "does-not-exist.db"));
    const { dates, partialFailure } = reader.readDistinctVisitDates();
    reader.close();

    expect(dates).toEqual([]);
    expect(partialFailure).toBe(true);
  });
});

// A database the OS refuses to open (full-disk access denied) reports
// "unable to open database file" — the same message better-sqlite3 gives
// for a database that is simply missing. `canDenyReads` skips this suite
// when running as root, since root bypasses the file-mode denial these
// tests rely on to reproduce that message deterministically.
const canDenyReads = (process.getuid?.() ?? 0) !== 0;

describe.skipIf(!canDenyReads)("Safari reader — permission denial", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-test-safari-denied-"));
    const result = createSafariDb(tmpDir);
    dbPath = result.dbPath;
    insertSafariVisit(result.db, 1, 1, "https://apple.com", "Apple", APRIL_16_10AM_SAFARI, 0);
    result.db.close();
    chmodSync(dbPath, 0o000);
  });

  afterAll(() => {
    chmodSync(dbPath, 0o644);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function expectPermissionSyncError(fn: () => void) {
    let caught: unknown;
    try {
      fn();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SyncError);
    const err = caught as SyncError;
    expect(err.kind).toBe("permission");
    expect(err.scope).toBe("source");
    expect(err.remediation?.restartRequired).toBe(true);
    expect(err.remediation?.executable).toBe(process.execPath);
  }

  test("readVisits raises a permission SyncError instead of a silent profile failure", () => {
    const reader = SafariHistoryReader.withPath(dbPath);
    expectPermissionSyncError(() => reader.readVisits({}, 0, 100));
  });

  test("readVisitsForDate raises a permission SyncError", () => {
    const reader = SafariHistoryReader.withPath(dbPath);
    expectPermissionSyncError(() => reader.readVisitsForDate("2026-04-16"));
  });

  test("readDistinctVisitDates raises a permission SyncError instead of partialFailure", () => {
    const reader = SafariHistoryReader.withPath(dbPath);
    expectPermissionSyncError(() => reader.readDistinctVisitDates());
  });
});

describe("Daily aggregation", () => {
  const visits: RawVisit[] = [
    {
      url: "https://github.com",
      domain: "github.com",
      title: "GitHub",
      timestamp: APRIL_16_10AM_MS,
      isSynced: false,
      profile: "default",
      browser: "chrome",
      visitDuration: 120,
    },
    {
      url: "https://github.com/pulls",
      domain: "github.com",
      title: "PRs",
      timestamp: APRIL_16_10AM_MS + 60000,
      isSynced: false,
      profile: "default",
      browser: "chrome",
      visitDuration: 60,
    },
    {
      url: "https://stackoverflow.com",
      domain: "stackoverflow.com",
      title: "SO",
      timestamp: APRIL_16_10AM_MS + 120000,
      isSynced: false,
      profile: "default",
      browser: "chrome",
    },
    {
      url: "https://example.com",
      domain: "example.com",
      title: "Next Day",
      timestamp: APRIL_17_9AM_MS,
      isSynced: false,
      profile: "default",
      browser: "chrome",
    },
  ];

  test("aggregates correctly by date", () => {
    const results = aggregateDaily(visits);
    expect(results).toHaveLength(2);

    const april16 = results.find((r) => r.date === "2026-04-16");
    expect(april16).toBeDefined();
    expect(april16!.total_visits).toBe(3);
    expect(april16!.unique_domains).toBe(2); // github.com, stackoverflow.com
    expect(april16!.unique_urls).toBe(3);
    expect(april16!.total_duration_seconds).toBe(180); // 120 + 60
    expect(april16!.top_domain).toBe("github.com"); // 2 visits vs 1

    const april17 = results.find((r) => r.date === "2026-04-17");
    expect(april17).toBeDefined();
    expect(april17!.total_visits).toBe(1);
  });

  test("filters by date set when provided", () => {
    const results = aggregateDaily(visits, new Set(["2026-04-16"]));
    expect(results).toHaveLength(1);
    expect(results[0].date).toBe("2026-04-16");
  });
});

describe("Daily document builder", () => {
  test("builds markdown document with time headings", () => {
    const visits: RawVisit[] = [
      {
        url: "https://github.com",
        domain: "github.com",
        title: "GitHub",
        timestamp: APRIL_16_10AM_MS,
        isSynced: false,
        profile: "default",
        browser: "chrome",
      },
      {
        url: "https://docs.rs",
        domain: "docs.rs",
        title: "Docs.rs",
        timestamp: APRIL_16_10AM_MS + 60000,
        isSynced: false,
        profile: "default",
        browser: "chrome",
      },
      {
        url: "https://stackoverflow.com",
        domain: "stackoverflow.com",
        title: "Stack Overflow",
        timestamp: APRIL_16_230PM_MS,
        isSynced: false,
        profile: "default",
        browser: "chrome",
      },
    ];

    const doc = buildDailyDocument(
      "chrome",
      "Google Chrome",
      "2026-04-16",
      visits,
      SourceId("browser-history:chrome"),
      ProviderId("browser-history"),
      false,
    );

    expect(doc.externalId).toBe("chrome:2026-04-16");
    expect(doc.title).toBe("Google Chrome browsing — April 16, 2026");
    expect(doc.metadata.documentType).toBe("browsing-history");
    expect(doc.content).toContain("## 10:00");
    expect(doc.content).toContain("[GitHub](https://github.com)");
    expect(doc.content).toContain("## 14:30");
    expect(doc.content).toContain("[Stack Overflow](https://stackoverflow.com)");
    expect(doc.sourceCreatedAt).toBe("2026-04-16T00:00:00.000Z");
    expect(doc.sourceUpdatedAt).toBe("2026-04-16T23:59:59.999Z");
  });

  test("includes profile labels when multiple profiles", () => {
    const visits: RawVisit[] = [
      {
        url: "https://github.com",
        domain: "github.com",
        title: "GitHub",
        timestamp: APRIL_16_10AM_MS,
        isSynced: false,
        profile: "Work",
        browser: "chrome",
      },
    ];

    const doc = buildDailyDocument(
      "chrome",
      "Google Chrome",
      "2026-04-16",
      visits,
      SourceId("browser-history:chrome"),
      ProviderId("browser-history"),
      true,
    );
    expect(doc.content).toContain("_(Work)_");
  });

  test("includes visit duration when available", () => {
    const visits: RawVisit[] = [
      {
        url: "https://github.com",
        domain: "github.com",
        title: "GitHub",
        timestamp: APRIL_16_10AM_MS,
        isSynced: false,
        profile: "default",
        browser: "chrome",
        visitDuration: 323,
      },
    ];

    const doc = buildDailyDocument(
      "chrome",
      "Google Chrome",
      "2026-04-16",
      visits,
      SourceId("browser-history:chrome"),
      ProviderId("browser-history"),
      false,
    );
    expect(doc.content).toContain("5m 23s");
  });

  test("uses domain as fallback when title is empty", () => {
    const visits: RawVisit[] = [
      {
        url: "https://example.com/path",
        domain: "example.com",
        title: "",
        timestamp: APRIL_16_10AM_MS,
        isSynced: false,
        profile: "default",
        browser: "chrome",
      },
    ];

    const doc = buildDailyDocument(
      "chrome",
      "Google Chrome",
      "2026-04-16",
      visits,
      SourceId("browser-history:chrome"),
      ProviderId("browser-history"),
      false,
    );
    expect(doc.content).toContain("[example.com](https://example.com/path)");
  });
});

describe("Source definition metadata", () => {
  test("has correct top-level properties", () => {
    expect(definition.id).toBe("browser-history");
    expect(definition.name).toBe("Browser History");
    expect(definition.authType).toBe("local");
    expect(definition.type).toBe("source");
    expect(definition.analyticsSchemas).toHaveLength(3);
    expect(definition.icon).toBeDefined();
  });

  test("schemas have correct table names", () => {
    const names = (definition.analyticsSchemas ?? []).map((s) => s.tableName);
    expect(names).toContain("browser_visits");
    expect(names).toContain("browser_daily");
    expect(names).toContain("browser_search_terms");
  });
});

describe("Full sync cycle (Chromium)", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-test-sync-chromium-"));
    const { db } = createChromiumDb(tmpDir);

    insertChromiumVisit(db, 1, 1, "https://github.com", "GitHub", APRIL_16_10AM_CHROMIUM, {
      transition: 1,
      duration: 60_000_000,
    });
    insertChromiumVisit(
      db,
      2,
      2,
      "https://docs.rs",
      "Docs.rs",
      APRIL_16_10AM_CHROMIUM + 1_000_000,
      { transition: 0 },
    );
    insertChromiumVisit(db, 3, 3, "https://stackoverflow.com/q/1", "SO", APRIL_16_230PM_CHROMIUM, {
      synced: true,
    });
    insertChromiumVisit(db, 4, 4, "https://example.com", "Next Day", APRIL_17_9AM_CHROMIUM);

    // Internal page that should be filtered
    insertChromiumVisit(
      db,
      5,
      5,
      "chrome://settings",
      "Settings",
      APRIL_16_10AM_CHROMIUM + 3_000_000,
    );

    // Search term
    db.prepare(
      `INSERT INTO keyword_search_terms (keyword_id, url_id, term, normalized_term) VALUES (1, 3, 'rust error handling', 'rust error handling')`,
    ).run();

    db.close();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createInstance() {
    return definition.create!({
      accountId: "chrome",
      sourceId: SourceId("browser-history:chrome"),
      providerId: ProviderId("browser-history:chrome"),
      sourceConfig: { enabled: true, params: { baseDir: tmpDir } },
    });
  }

  test("runs through all 5 phases", async () => {
    // Patch getBrowserInfo to use our temp dir
    const origGetBrowserInfo = (await import("./paths.js")).getBrowserInfo;

    // We need to test the sync cycle with a real instance, but we can't easily
    // override getBrowserInfo. Instead, let's test the readers and aggregation directly.
    // The source instance requires the browser to be detected on the system.
    // For a full integration test, we'd need to mock the detection.
    // Here we test the individual components that make up the sync cycle.

    const reader = new ChromiumHistoryReader({
      id: "chrome",
      name: "Chrome",
      baseDir: tmpDir,
      engine: "chromium",
    });

    // Phase 1: Read visits
    const { visits, hasMore } = reader.readVisits({}, 0, 5000);
    expect(visits.length).toBe(5); // includes chrome://settings and hidden
    const filtered = visits.filter((v) => shouldIncludeVisit(v));
    expect(filtered.length).toBe(4); // chrome://settings filtered out

    // Phase 2: Aggregate daily
    const dailyRecords = aggregateDaily(filtered);
    expect(dailyRecords.length).toBe(2); // April 16 and April 17
    const april16 = dailyRecords.find((r) => r.date === "2026-04-16");
    expect(april16!.total_visits).toBe(3);

    // Phase 3: Search terms
    const { terms } = reader.readSearchTerms({}, 0, 5000);
    expect(terms.length).toBe(1);

    // Phase 4: Documents
    const april16Visits = reader.readVisitsForDate("2026-04-16");
    const filteredDay = april16Visits.filter((v) => shouldIncludeVisit(v));
    const doc = buildDailyDocument(
      "chrome",
      "Google Chrome",
      "2026-04-16",
      filteredDay,
      SourceId("browser-history:chrome"),
      ProviderId("browser-history"),
      false,
    );
    expect(doc.content).toContain("GitHub");
    expect(doc.content).not.toContain("chrome://settings");

    reader.close();
  });
});

describe("Full sync cycle (Safari)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-test-sync-safari-"));
    const { db, dbPath: path } = createSafariDb(tmpDir);
    dbPath = path;

    insertSafariVisit(db, 1, 1, "https://apple.com", "Apple", APRIL_16_10AM_SAFARI, 0);
    insertSafariVisit(
      db,
      2,
      2,
      "https://developer.apple.com",
      "Dev Docs",
      APRIL_16_10AM_SAFARI + 600,
      0,
    );
    insertSafariVisit(
      db,
      3,
      3,
      "https://reddit.com/r/swift",
      "r/swift",
      APRIL_16_10AM_SAFARI + 1800,
      2,
    );

    db.close();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads and processes Safari history correctly", () => {
    const reader = SafariHistoryReader.withPath(dbPath);

    const { visits } = reader.readVisits({}, 0, 5000);
    expect(visits.length).toBe(3);
    expect(visits.every((v) => v.browser === "safari")).toBe(true);
    expect(visits.every((v) => v.profile === "default")).toBe(true);

    // Check sync detection
    const syncedVisit = visits.find((v) => v.url === "https://reddit.com/r/swift");
    expect(syncedVisit?.isSynced).toBe(true);

    // Build daily document
    const doc = buildDailyDocument(
      "safari",
      "Safari",
      "2026-04-16",
      visits,
      SourceId("browser-history:safari"),
      ProviderId("browser-history"),
      false,
    );
    expect(doc.title).toBe("Safari browsing — April 16, 2026");
    expect(doc.content).toContain("[Apple](https://apple.com/)");
    expect(doc.content).toContain("[r/swift](https://reddit.com/r/swift)");

    // No transition types for Safari
    expect(visits.every((v) => v.transitionType === undefined)).toBe(true);

    // No visit duration for Safari
    expect(visits.every((v) => v.visitDuration === undefined)).toBe(true);

    reader.close();
  });
});

describe("Incremental sync", () => {
  test("cursor advances correctly for Chromium", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "omnesis-test-incremental-"));
    try {
      const { db } = createChromiumDb(tmpDir);
      insertChromiumVisit(db, 1, 1, "https://github.com", "GitHub", APRIL_16_10AM_CHROMIUM);
      db.close();

      const reader1 = new ChromiumHistoryReader({
        id: "chrome",
        name: "Chrome",
        baseDir: tmpDir,
        engine: "chromium",
      });

      // First read: gets 1 visit
      const batch1 = reader1.readVisits({}, 0, 5000);
      expect(batch1.visits.length).toBe(1);
      const lastTimestamp = msToChromiumTimestamp(batch1.visits[0].timestamp);

      // Second read with cursor: gets 0 visits
      const batch2 = reader1.readVisits({}, lastTimestamp, 5000);
      expect(batch2.visits.length).toBe(0);
      reader1.close();

      // Add a new visit to the DB. Each reader holds a
      // per-cycle snapshot for its lifetime, so we instantiate a fresh
      // reader to see writes that happened after reader1's snapshot.
      const db2 = new Database(join(tmpDir, "Default", "History"));
      insertChromiumVisit(db2, 2, 2, "https://example.com", "New Visit", APRIL_16_230PM_CHROMIUM);
      db2.close();

      const reader2 = new ChromiumHistoryReader({
        id: "chrome",
        name: "Chrome",
        baseDir: tmpDir,
        engine: "chromium",
      });
      const batch3 = reader2.readVisits({}, lastTimestamp, 5000);
      expect(batch3.visits.length).toBe(1);
      expect(batch3.visits[0].url).toBe("https://example.com/");

      reader2.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Multi-profile Chromium", () => {
  test("reads visits from multiple profiles", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "omnesis-test-multiprofile-"));
    try {
      // Create Local State with two profiles
      const localState = {
        profile: {
          info_cache: {
            Default: { name: "Personal", user_name: "" },
            "Profile 1": { name: "Work", user_name: "work@co.com" },
          },
        },
      };
      writeFileSync(join(tmpDir, "Local State"), JSON.stringify(localState));

      // Create Default profile DB
      mkdirSync(join(tmpDir, "Default"), { recursive: true });
      const db1 = new Database(join(tmpDir, "Default", "History"));
      db1
        .prepare(
          `CREATE TABLE urls (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0, typed_count INTEGER DEFAULT 0, last_visit_time INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0)`,
        )
        .run();
      db1
        .prepare(
          `CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, from_visit INTEGER DEFAULT 0, transition INTEGER DEFAULT 0, visit_duration INTEGER DEFAULT 0, is_known_to_sync INTEGER DEFAULT 0, originator_cache_guid TEXT DEFAULT '')`,
        )
        .run();
      db1.prepare(`CREATE TABLE visit_source (id INTEGER, source INTEGER)`).run();
      db1
        .prepare(
          `CREATE TABLE keyword_search_terms (keyword_id INTEGER, url_id INTEGER, term TEXT, normalized_term TEXT)`,
        )
        .run();
      insertChromiumVisit(db1, 1, 1, "https://github.com", "GitHub", APRIL_16_10AM_CHROMIUM);
      db1.close();

      // Create Profile 1 DB
      mkdirSync(join(tmpDir, "Profile 1"), { recursive: true });
      const db2 = new Database(join(tmpDir, "Profile 1", "History"));
      db2
        .prepare(
          `CREATE TABLE urls (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0, typed_count INTEGER DEFAULT 0, last_visit_time INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0)`,
        )
        .run();
      db2
        .prepare(
          `CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, from_visit INTEGER DEFAULT 0, transition INTEGER DEFAULT 0, visit_duration INTEGER DEFAULT 0, is_known_to_sync INTEGER DEFAULT 0, originator_cache_guid TEXT DEFAULT '')`,
        )
        .run();
      db2.prepare(`CREATE TABLE visit_source (id INTEGER, source INTEGER)`).run();
      db2
        .prepare(
          `CREATE TABLE keyword_search_terms (keyword_id INTEGER, url_id INTEGER, term TEXT, normalized_term TEXT)`,
        )
        .run();
      insertChromiumVisit(db2, 1, 1, "https://jira.company.com", "Jira", APRIL_16_230PM_CHROMIUM);
      db2.close();

      const reader = new ChromiumHistoryReader({
        id: "chrome",
        name: "Chrome",
        baseDir: tmpDir,
        engine: "chromium",
      });

      expect(reader.hasMultipleProfiles()).toBe(true);

      const { visits } = reader.readVisits({}, 0, 5000);
      expect(visits.length).toBe(2);

      const personal = visits.find((v) => v.url === "https://github.com/");
      expect(personal?.profile).toBe("Personal");

      const work = visits.find((v) => v.url === "https://jira.company.com/");
      expect(work?.profile).toBe("work@co.com");

      // Watch paths should include both profiles
      const watchPaths = reader.getWatchPaths();
      expect(watchPaths.length).toBe(4); // 2 profiles × 2 files

      reader.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("browser_daily accumulation across incremental cycles", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-test-daily-accum-"));
    const { db } = createChromiumDb(tmpDir);
    // K=2 visits on 2026-04-16 in the first cycle.
    insertChromiumVisit(db, 1, 1, "https://github.com", "GitHub", APRIL_16_10AM_CHROMIUM);
    insertChromiumVisit(db, 2, 2, "https://docs.rs", "Docs.rs", APRIL_16_10AM_CHROMIUM + 1_000_000);
    db.close();
    browserInfoMock.baseDir = tmpDir;
  });

  afterAll(() => {
    browserInfoMock.baseDir = "";
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Drive syncStructured through one full cycle (phase "visits" → "done")
   * and return the total_visits emitted to browser_daily for the given date.
   */
  async function runCycleAndGetDailyTotal(
    instance: Awaited<ReturnType<NonNullable<typeof definition.create>>>,
    cursor: BrowserHistoryCursor | undefined,
    date: string,
  ): Promise<{ cursor: BrowserHistoryCursor; total: number | undefined }> {
    // The source's own contract: a structured source declares `syncStructured`,
    // and this helper exists to drive it. Asserting it here rather than
    // asserting through it keeps the failure legible if the descriptor changes.
    const syncStructured = instance.syncStructured;
    if (!syncStructured) throw new Error("this source does not sync structured tables");
    let cur = cursor ?? null;
    let total: number | undefined;
    let guard = 0;
    for (;;) {
      if (guard++ > 20) throw new Error("syncStructured did not terminate");
      const result = await syncStructured.call(instance, cur);
      cur = result.cursor as BrowserHistoryCursor;
      if (tablesWritten(result).includes("browser_daily")) {
        const row = rowsFor(result, "browser_daily").find((r) => r.date === date);
        if (row) total = Number(row.total_visits);
      }
      if (!result.hasMore) break;
    }
    return { cursor: cur!, total };
  }

  test("second cycle on the same day sums the full day, not just the new visits", async () => {
    const instance = await definition.create!({
      accountId: "chrome",
      sourceId: SourceId("browser-history:chrome"),
      providerId: ProviderId("browser-history"),
      sourceConfig: { enabled: true, params: {} },
    });

    // Cycle 1: 2 visits on 2026-04-16.
    const cycle1 = await runCycleAndGetDailyTotal(instance, undefined, "2026-04-16");
    expect(cycle1.total).toBe(2);

    // A later visit lands on the same calendar day, after cycle 1's watermark.
    const db = new Database(join(tmpDir, "Default", "History"));
    insertChromiumVisit(db, 3, 3, "https://example.com", "Example", APRIL_16_230PM_CHROMIUM);
    db.close();

    // Cycle 2 ingests only the 1 new visit, but browser_daily must reflect the
    // full day (3 visits) — not overwrite the prior total with the partial 1.
    const cycle2 = await runCycleAndGetDailyTotal(instance, cycle1.cursor, "2026-04-16");
    expect(cycle2.total).toBe(3);
  });
});

describe("history coverage — the browser prunes its own store", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-test-coverage-"));
    const { db } = createChromiumDb(tmpDir);
    insertChromiumVisit(db, 1, 1, "https://example.com", "Example", APRIL_16_10AM_CHROMIUM);
    db.close();
    browserInfoMock.baseDir = tmpDir;
  });

  afterAll(() => {
    browserInfoMock.baseDir = "";
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("final profile enumeration warns on a missing profile and clears after recovery", async () => {
    const instance = await definition.create!({
      accountId: "chrome",
      sourceId: SourceId("browser-history:chrome"),
      providerId: ProviderId("browser-history"),
      sourceConfig: { enabled: true, params: {} },
    });
    const cursor: BrowserHistoryCursor = {
      phase: "documents",
      lastVisitTime: {},
      visitsProcessed: 0,
      affectedDates: [],
    };
    const readDates = vi.spyOn(ChromiumHistoryReader.prototype, "readDistinctVisitDates");
    try {
      readDates.mockReturnValueOnce({ dates: [], partialFailure: true });
      const withheld = await instance.syncStructured!(cursor);
      expect(withheld.hasMore).toBe(false);
      expect(withheld.presentExternalIds).toBeUndefined();
      expect(withheld.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
      readDates.mockRestore();
      const recovered = await instance.syncStructured!({ ...cursor, phase: "documents" });
      expect(recovered.presentExternalIds).toEqual(["chrome:2026-04-16"]);
      expect(recovered.issues).toEqual([]);
    } finally {
      readDates.mockRestore();
    }
  });

  /** Drive syncStructured through one full cycle, collecting every progress report. */
  async function runCycleCollectingProgress(
    instance: Awaited<ReturnType<NonNullable<typeof definition.create>>>,
    cursor: BrowserHistoryCursor | null,
  ): Promise<{ cursor: BrowserHistoryCursor; progresses: SyncProgress[] }> {
    const syncStructured = instance.syncStructured;
    if (!syncStructured) throw new Error("this source does not sync structured tables");
    let cur = cursor;
    const progresses: SyncProgress[] = [];
    let guard = 0;
    for (;;) {
      if (guard++ > 20) throw new Error("syncStructured did not terminate");
      const result = await syncStructured.call(instance, cur);
      cur = result.cursor as BrowserHistoryCursor;
      if (result.progress) progresses.push(result.progress);
      if (!result.hasMore) break;
    }
    return { cursor: cur!, progresses };
  }

  test("the visits phase reports coverage 'unknown' with a factual detail — every cycle, not only the first", async () => {
    const instance = await definition.create!({
      accountId: "chrome",
      sourceId: SourceId("browser-history:chrome"),
      providerId: ProviderId("browser-history"),
      sourceConfig: { enabled: true, params: {} },
    });

    const cycle1 = await runCycleCollectingProgress(instance, null);
    expect(cycle1.progresses).toHaveLength(1);
    expect(cycle1.progresses[0]).toMatchObject({ coverage: "unknown" });
    expect(cycle1.progresses[0].detail).toBeTruthy();
    // PII-free, factual claim — no mention of any specific site or account.
    expect(cycle1.progresses[0].detail).not.toContain("example.com");

    // A second, later cycle reads the same possibly-pruned database — the
    // claim holds unconditionally, not only on the very first read.
    const db2 = new Database(join(tmpDir, "Default", "History"));
    insertChromiumVisit(db2, 2, 2, "https://example.org", "example org", APRIL_16_230PM_CHROMIUM);
    db2.close();

    const cycle2 = await runCycleCollectingProgress(instance, cycle1.cursor);
    expect(cycle2.progresses).toHaveLength(1);
    expect(cycle2.progresses[0]).toMatchObject({ coverage: "unknown" });
  });
});

describe("buildDailyEdges — browsing-history → webpage (#895)", () => {
  const makeVisit = (url: string, timestamp = APRIL_16_10AM_MS): RawVisit => ({
    url,
    domain: extractDomain(url),
    title: "Example",
    timestamp,
    isSynced: false,
    profile: "default",
    browser: "chrome",
  });

  test("declares one `visited` edge per distinct URL, from the day document", () => {
    const visits = [makeVisit("https://example.com/a"), makeVisit("https://example.com/b")];
    const edges = buildDailyEdges("chrome", "2026-04-16", visits);
    expect(edges).toHaveLength(2);
    for (const edge of edges) {
      expect(edge.type).toBe("visited");
      // from = the day document this source emits (internal, `${browser}:${date}`).
      expect(edge.from).toEqual({ kind: "internal", sourceDocumentId: "chrome:2026-04-16" });
    }
    expect(edges.map((e) => e.to)).toEqual([
      webPageEdgeTarget("https://example.com/a"),
      webPageEdgeTarget("https://example.com/b"),
    ]);
  });

  test("dedupes a page visited many times in a day onto one edge", () => {
    const visits = [
      makeVisit("https://example.com/a", APRIL_16_10AM_MS),
      makeVisit("https://example.com/a", APRIL_16_10AM_MS + 60_000),
      makeVisit("https://example.com/a", APRIL_16_10AM_MS + 120_000),
    ];
    const edges = buildDailyEdges("chrome", "2026-04-16", visits);
    expect(edges).toHaveLength(1);
    expect(edges[0].to).toEqual(webPageEdgeTarget("https://example.com/a"));
  });

  test("returns no edges for a day with no visits", () => {
    expect(buildDailyEdges("chrome", "2026-04-16", [])).toEqual([]);
  });
});
