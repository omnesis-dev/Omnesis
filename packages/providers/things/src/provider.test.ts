// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
type Db = Database.Database;
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { nodePathProbe, resolveDeclaredPaths } from "@omnesis/source-sdk";
import { SourceId, ProviderId } from "@omnesis/types";
import thingsProvider, { findThingsDbPath, thingsPathValidationError } from "./index.js";

describe("Things provider definition", () => {
  test("declares macOS-only via supportedPlatforms", () => {
    // Things 3 is a macOS app; the source must not be advertised on
    // Linux/Windows.
    expect(thingsProvider.supportedPlatforms).toEqual(["darwin"]);
  });

  test("declares replicated stores and keeps the database path member-local", () => {
    expect(thingsProvider.multiDevice).toEqual({
      mode: "replicated",
      replicaVersionPolicy: "source-updated-at",
    });
    expect(thingsProvider.params?.find((param) => param.name === "dbPath")?.scope).toBe("member");
  });
});

function createMinimalThingsDb(path: string): void {
  const db = new Database(path);
  db.exec(
    "CREATE TABLE TMTask (uuid TEXT PRIMARY KEY, title TEXT, type INTEGER DEFAULT 0, trashed INTEGER DEFAULT 0)",
  );
  db.exec("INSERT INTO TMTask VALUES ('1', 'Test task', 0, 0)");
  db.close();
}

describe("findThingsDbPath", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-things-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    tempDirs.length = 0;
  });

  test("returns null when basePath doesn't exist", () => {
    expect(findThingsDbPath("/nonexistent/path")).toBeNull();
  });

  test("returns null when no ThingsData- directories exist", () => {
    const dir = makeTempDir();
    expect(findThingsDbPath(dir)).toBeNull();
  });

  test("finds database in ThingsData- subdirectory", () => {
    const baseDir = makeTempDir();
    const thingsDataDir = join(baseDir, "ThingsData-12345", "Things Database.thingsdatabase");
    mkdirSync(thingsDataDir, { recursive: true });
    const dbPath = join(thingsDataDir, "main.sqlite");
    createMinimalThingsDb(dbPath);

    const result = findThingsDbPath(baseDir);
    expect(result).toBe(dbPath);
  });

  test("returns null when ThingsData- dir exists but no db file", () => {
    const baseDir = makeTempDir();
    mkdirSync(join(baseDir, "ThingsData-12345"), { recursive: true });

    expect(findThingsDbPath(baseDir)).toBeNull();
  });

  test("accepts member-local tilde and relative database paths, resolved by the host", async () => {
    const home = makeTempDir();
    const dbPath = join(home, "Library", "Things", "main.sqlite");
    mkdirSync(join(home, "Library", "Things"), { recursive: true });
    createMinimalThingsDb(dbPath);
    vi.stubEnv("HOME", home);

    const schema = thingsProvider.config!;
    const pathParam = thingsProvider.params?.find((param) => param.name === "dbPath");

    for (const typed of ["~/Library/Things/main.sqlite", relative(process.cwd(), dbPath)]) {
      // The form accepts what the operator typed...
      expect(pathParam?.validate?.(typed)).toBeNull();

      // ...the host resolves it once...
      const parsed = schema.parse({ dbPath: typed });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const handed = resolveDeclaredPaths(
        schema,
        parsed.value as Record<string, unknown>,
        nodePathProbe,
      );

      // ...and the source opens exactly the file the form just approved.
      const instance = await thingsProvider.create!({
        accountId: "local",
        sourceId: SourceId("things:local"),
        providerId: ProviderId("things:local"),
        config: handed as { dbPath?: string },
      });
      expect(instance.watchPaths).toContain(dbPath);
    }
  });

  test("rejects a missing explicit replica database", () => {
    const pathParam = thingsProvider.params?.find((param) => param.name === "dbPath");
    expect(pathParam?.validate?.("/nonexistent/things/main.sqlite")).toBe("File does not exist");
  });

  test("distinguishes macOS privacy refusal from a missing replica database", () => {
    expect(
      thingsPathValidationError(Object.assign(new Error("denied"), { code: "EPERM" })),
    ).toSatisfy((message: string) => message.toLowerCase().includes("full disk access"));
    expect(thingsPathValidationError(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe(
      "File does not exist",
    );
  });
});

// The freshness declaration is load-bearing, not decorative. `pgrep -x` is an
// exact match, so a typo in the process name yields a definite "not running"
// rather than an error — which collapses the three-way conjunction to a single
// condition and starts producing false stale warnings after a quiet fortnight.
// A wrong name is worse than no declaration at all.
describe("Things freshness declaration", () => {
  test("declares the Things process and a generous quiet window", async () => {
    const instance = await thingsProvider.create!({
      accountId: "local",
      sourceId: SourceId("things:local"),
      providerId: ProviderId("things:local"),
      config: { dbPath: "/nonexistent/main.sqlite" },
    });

    expect(instance.freshness?.requiresProcess?.processName).toBe("Things3");
    // Two weeks. Short enough to be useful, long enough that an ordinary
    // holiday doesn't trip it.
    expect(instance.freshness?.quietPeriodMs).toBe(14 * 24 * 60 * 60 * 1000);
    expect(instance.freshness?.hint).toMatch(/Things/);
  });

  // A Mac collector reopens Things when it finds it quit. The bundle id is what
  // `open -b` resolves; a wrong one makes every launch fail quietly.
  test("declares how a Mac collector reopens Things, and what to say when that fails", async () => {
    const instance = await thingsProvider.create!({
      accountId: "local",
      sourceId: SourceId("things:local"),
      providerId: ProviderId("things:local"),
      config: { dbPath: "/nonexistent/main.sqlite" },
    });

    expect(instance.freshness?.requiresProcess?.launch?.macosBundleId).toBe(
      "com.culturedcode.ThingsMac",
    );
    expect(instance.freshness?.requiresProcess?.launch?.failedHint).toMatch(/Things/);
  });
});
