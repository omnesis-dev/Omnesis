// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { writeFileSync, existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { openSqliteSnapshot } from "./sqlite-snapshot.js";

describe("openSqliteSnapshot", () => {
  it("refuses an existing unreadable sidecar instead of returning an incomplete copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-sidecar-failure-"));
    const src = join(dir, "History");
    writeFileSync(src, "fixture");
    mkdirSync(src + "-wal");
    let snapshot: ReturnType<typeof openSqliteSnapshot> | undefined;
    try {
      expect(() => {
        snapshot = openSqliteSnapshot(src);
      }).toThrow();
    } finally {
      snapshot?.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("copies a single-file DB into a temp directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-test-src-"));
    const src = join(dir, "History");
    writeFileSync(src, "SQLITE-bytes");

    const snap = openSqliteSnapshot(src, "snap-test-");
    try {
      expect(existsSync(snap.path)).toBe(true);
      expect(readFileSync(snap.path).toString()).toBe("SQLITE-bytes");
      expect(snap.path).not.toBe(src);
    } finally {
      snap.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(existsSync(snap.path)).toBe(false);
  });

  it("copies the -wal / -shm / -journal sidecars when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-test-src-"));
    const src = join(dir, "History");
    writeFileSync(src, "main");
    writeFileSync(src + "-wal", "wal");
    writeFileSync(src + "-shm", "shm");
    // intentionally no -journal — should be skipped without error

    const snap = openSqliteSnapshot(src, "snap-test-");
    try {
      expect(readFileSync(snap.path + "-wal").toString()).toBe("wal");
      expect(readFileSync(snap.path + "-shm").toString()).toBe("shm");
      expect(existsSync(snap.path + "-journal")).toBe(false);
    } finally {
      snap.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleanup removes the entire temp directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-test-src-"));
    const src = join(dir, "History");
    writeFileSync(src, "x");

    const snap = openSqliteSnapshot(src, "snap-test-");
    expect(existsSync(snap.path)).toBe(true);
    snap.cleanup();
    expect(existsSync(snap.path)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves the source filename in the snapshot path", () => {
    const dir = mkdtempSync(join(tmpdir(), "snap-test-src-"));
    const src = join(dir, "knowledgeC.db");
    writeFileSync(src, "x");

    const snap = openSqliteSnapshot(src, "snap-test-");
    try {
      expect(snap.path.endsWith("/knowledgeC.db")).toBe(true);
    } finally {
      snap.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
