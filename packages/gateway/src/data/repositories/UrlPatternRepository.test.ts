// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "../schema.js";
import { runMigrations } from "../migrations.js";
import { extractIdFromUrl } from "../../domain/UrlOwnershipReconciliation.js";
import {
  getCachedUrlIdPatterns,
  getUrlIdPatterns,
  invalidateUrlIdPatternCache,
} from "./UrlPatternRepository.js";

type Db = Database.Database;

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => {
  invalidateUrlIdPatternCache();
  db.close();
});

function insertPatterns(sourceId: string, patterns: unknown): void {
  db.prepare(`INSERT INTO sync_state (source_id, cursor, url_patterns) VALUES (?, '{}', ?)`).run(
    sourceId,
    JSON.stringify(patterns),
  );
}

describe("getUrlIdPatterns (SEC-18 read-path hardening)", () => {
  test("compiles valid patterns", () => {
    insertPatterns("strava:athlete", [{ regex: "strava\\.com/activities/(\\d+)", idGroup: 1 }]);
    const out = getUrlIdPatterns(db);
    expect(out).toHaveLength(1);
    expect(out[0].sourceTypePrefix).toBe("strava");
    expect(out[0].regex.test("strava.com/activities/123")).toBe(true);
  });

  test("skips an uncompilable stored pattern instead of throwing", () => {
    // A row written by an older build (before the write-boundary validation)
    // could hold an invalid regex. One bad row must not break URL resolution
    // for every other source.
    insertPatterns("legacy:acct", [{ regex: "([a-z" }]);
    insertPatterns("strava:athlete", [{ regex: "strava\\.com/activities/(\\d+)", idGroup: 1 }]);
    let out: ReturnType<typeof getUrlIdPatterns> = [];
    expect(() => {
      out = getUrlIdPatterns(db);
    }).not.toThrow();
    // The good pattern still resolves; the bad one is dropped.
    expect(out.map((p) => p.sourceTypePrefix)).toEqual(["strava"]);
  });

  test("skips a row whose url_patterns column is not valid JSON", () => {
    db.prepare(`INSERT INTO sync_state (source_id, cursor, url_patterns) VALUES (?, '{}', ?)`).run(
      "broken:acct",
      "{not json",
    );
    insertPatterns("strava:athlete", [{ regex: "strava\\.com/activities/(\\d+)" }]);
    let out: ReturnType<typeof getUrlIdPatterns> = [];
    expect(() => {
      out = getUrlIdPatterns(db);
    }).not.toThrow();
    expect(out.map((p) => p.sourceTypePrefix)).toEqual(["strava"]);
  });

  test("skips legacy rows with a non-array shape or more than 50 entries", () => {
    insertPatterns("object:acct", { regex: "object[.]example" });
    insertPatterns(
      "oversized:acct",
      Array.from({ length: 51 }, (_, index) => ({ regex: `item-${index}` })),
    );
    insertPatterns("strava:athlete", [{ regex: "strava\\.com/activities/(\\d+)" }]);

    expect(() => getUrlIdPatterns(db)).not.toThrow();
    expect(getUrlIdPatterns(db).map((p) => p.sourceTypePrefix)).toEqual(["strava"]);
  });

  test("skips oversized and malformed entries without discarding valid siblings", () => {
    insertPatterns("legacy:acct", [
      { regex: "x".repeat(301) },
      { regex: "legacy[.]example", idGroup: -1 },
      null,
      { regex: "valid[.]example", idGroup: 1 },
    ]);

    const out = getUrlIdPatterns(db);
    expect(out).toHaveLength(1);
    expect(out[0].regex.test("valid.example")).toBe(true);
  });

  test("filters an oversized legacy JSON cell before returning it to JavaScript", () => {
    db.prepare(`INSERT INTO sync_state (source_id, cursor, url_patterns) VALUES (?, '{}', ?)`).run(
      "legacy:huge",
      `[{"regex":"${"x".repeat(100_000)}"}]`,
    );
    insertPatterns("strava:athlete", [{ regex: "strava\\.com/activities/(\\d+)" }]);

    expect(getUrlIdPatterns(db).map((pattern) => pattern.sourceTypePrefix)).toEqual(["strava"]);
  });

  test("skips a malformed source id without discarding valid sibling rows", () => {
    insertPatterns("invalid source!", [{ regex: "broken[.]example" }]);
    insertPatterns("strava:athlete", [{ regex: "strava\\.com/activities/(\\d+)" }]);

    expect(() => getUrlIdPatterns(db)).not.toThrow();
    expect(getUrlIdPatterns(db).map((pattern) => pattern.sourceTypePrefix)).toEqual(["strava"]);
  });
});

describe("cached URL pattern staleness on a worker read handle", () => {
  // The IO worker resolves links on a permanent read-only handle and never
  // sees the HTTP boundary's `invalidateUrlIdPatternCache()` — that call is
  // main-thread module state. So the memo has to notice a source that
  // registered its url patterns after the worker's first link op, or a
  // `sources add` on a long-running gateway leaves every url-pattern link
  // unresolved until the process restarts.
  let file: string;
  let writer: Db;
  let reader: Db;

  beforeEach(() => {
    file = `/tmp/omnesis-test-${randomUUID()}.db`;
    writer = new Database(file);
    runSchemaSetup(writer);
    runMigrations(writer);
    reader = new Database(file, { readonly: true, fileMustExist: true });
    invalidateUrlIdPatternCache();
  });

  afterEach(() => {
    reader.close();
    writer.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (existsSync(file + suffix)) unlinkSync(file + suffix);
    }
  });

  test("picks up a source registered after the read handle first cached", () => {
    expect(getCachedUrlIdPatterns(reader)).toHaveLength(0);

    writer
      .prepare(`INSERT INTO sync_state (source_id, cursor, url_patterns) VALUES (?, '{}', ?)`)
      .run("notion:workspace", JSON.stringify([{ regex: "notion[.]so/([0-9a-f]+)", idGroup: 1 }]));

    expect(getCachedUrlIdPatterns(reader).map((p) => p.sourceTypePrefix)).toEqual(["notion"]);
    // …and the resolution helper that reads through the memo sees it too,
    // which is the whole point: strategy 2 (url-pattern → external_id).
    expect(extractIdFromUrl(reader, "https://notion.so/deadbeef00")).toEqual({
      id: "deadbeef00",
      sourceTypePrefix: "notion",
    });
  });

  test("keeps the same compiled array while unrelated writes land", () => {
    writer
      .prepare(`INSERT INTO sync_state (source_id, cursor, url_patterns) VALUES (?, '{}', ?)`)
      .run("strava:athlete", JSON.stringify([{ regex: "strava[.]com/activities/([0-9]+)" }]));
    const first = getCachedUrlIdPatterns(reader);

    writer
      .prepare(`INSERT INTO sync_state (source_id, cursor) VALUES (?, '{}')`)
      .run("gmail:mailbox");

    expect(getCachedUrlIdPatterns(reader)).toBe(first);
  });

  test("drops a source's patterns once its row loses them", () => {
    writer
      .prepare(`INSERT INTO sync_state (source_id, cursor, url_patterns) VALUES (?, '{}', ?)`)
      .run("strava:athlete", JSON.stringify([{ regex: "strava[.]com/activities/([0-9]+)" }]));
    expect(getCachedUrlIdPatterns(reader)).toHaveLength(1);

    writer.prepare(`DELETE FROM sync_state WHERE source_id = ?`).run("strava:athlete");

    expect(getCachedUrlIdPatterns(reader)).toHaveLength(0);
  });
});

describe("cached URL pattern lifecycle", () => {
  test("releases matchers across sustained cache invalidation", () => {
    insertPatterns(
      "records:account",
      Array.from({ length: 8 }, (_, index) => ({
        regex: `records[.]example/items/${index}/([0-9]+)`,
      })),
    );

    for (let generation = 0; generation < 2_000; generation += 1) {
      invalidateUrlIdPatternCache();
      expect(getCachedUrlIdPatterns(db)).toHaveLength(8);
    }
  });
});
