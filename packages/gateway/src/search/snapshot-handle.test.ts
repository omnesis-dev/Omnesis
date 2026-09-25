// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  upsertChunks,
  type ChunkUpsertInput,
} from "../indexer/db.js";
import { openSearchSnapshotHandle } from "./snapshot-handle.js";

function randVec(seed: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  let s = (seed * 0x9e3779b9) >>> 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    v[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  let n = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) n += v[i] * v[i];
  const norm = Math.sqrt(n) || 1;
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i] /= norm;
  return v;
}

function chunk(
  overrides: Partial<ChunkUpsertInput> & {
    id: string;
    documentId: string;
    embedding: Float32Array;
  },
): ChunkUpsertInput {
  return {
    chunkIndex: 0,
    content: overrides.content ?? `content for ${overrides.id}`,
    sourceId: "gmail",
    documentType: "email",
    title: `Title ${overrides.id}`,
    sourceCreatedAt: "2026-03-10T00:00:00Z",
    ...overrides,
  };
}

let writer: Db;
let path: string;

beforeEach(() => {
  path = `/tmp/omnesis-snapshot-${randomUUID()}.db`;
  writer = createIndexDatabase(path);
  // Seed at least one row so the handle has something to read.
  upsertChunks(writer, [chunk({ id: "seed", documentId: "doc-seed", embedding: randVec(1) })]);
});

afterEach(() => {
  try {
    writer.close();
  } catch {
    // ignore
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(path + suffix, { force: true });
  }
});

describe("openSearchSnapshotHandle", () => {
  test("opens in a long-lived BEGIN and exposes stats", () => {
    const handle = openSearchSnapshotHandle(path, {});
    try {
      // Reader can see seed row.
      const cnt = handle.db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number };
      expect(cnt.c).toBe(1);
      const stats = handle.stats();
      expect(stats.refreshCount).toBe(0);
      expect(stats.refreshErrors).toBe(0);
      expect(stats.openedAt).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  test("snapshot does NOT see writes until refresh", async () => {
    const handle = openSearchSnapshotHandle(path, {});
    try {
      const before = handle.db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number };
      expect(before.c).toBe(1);

      // Write via the original writer connection.
      upsertChunks(writer, [chunk({ id: "new1", documentId: "doc-new1", embedding: randVec(2) })]);

      // Snapshot reader still sees only the seed row.
      const afterWrite = handle.db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as {
        c: number;
      };
      expect(afterWrite.c).toBe(1);

      // Refresh snapshot.
      const dur = await handle.refresh();
      expect(dur).toBeGreaterThanOrEqual(0);

      const afterRefresh = handle.db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as {
        c: number;
      };
      expect(afterRefresh.c).toBe(2);

      const stats = handle.stats();
      expect(stats.refreshCount).toBe(1);
      expect(stats.lastRefreshAt).toBeGreaterThan(0);
      expect(stats.refreshErrors).toBe(0);
    } finally {
      handle.close();
    }
  });

  test("the snapshot is anchored at open, before any read goes through the handle", () => {
    const handle = openSearchSnapshotHandle(path, {});
    try {
      // The first statement on the handle comes AFTER this commit. A `BEGIN`
      // that only claims its WAL position on the first real read would see
      // the new row.
      upsertChunks(writer, [chunk({ id: "new1", documentId: "doc-new1", embedding: randVec(2) })]);

      const seen = handle.db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number };
      expect(seen.c, "a row committed between open and the first read is invisible").toBe(1);
    } finally {
      handle.close();
    }
  });

  test("a refresh re-anchors at refresh time, not at the next read", async () => {
    const handle = openSearchSnapshotHandle(path, {});
    try {
      await handle.refresh();
      upsertChunks(writer, [chunk({ id: "new1", documentId: "doc-new1", embedding: randVec(2) })]);

      const seen = handle.db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number };
      expect(seen.c, "a row committed between a refresh and the next read is invisible").toBe(1);
    } finally {
      handle.close();
    }
  });

  test("multiple refreshes increment refreshCount monotonically", async () => {
    const handle = openSearchSnapshotHandle(path, {});
    try {
      await handle.refresh();
      await handle.refresh();
      await handle.refresh();
      expect(handle.stats().refreshCount).toBe(3);
    } finally {
      handle.close();
    }
  });

  test("periodic refresher runs and advances refreshCount", async () => {
    const handle = openSearchSnapshotHandle(path, {
      refreshIntervalMs: 25,
    });
    try {
      await new Promise((r) => setTimeout(r, 120));
      const stats = handle.stats();
      // Within 120ms at 25ms cadence we expect at least 2 refreshes.
      expect(stats.refreshCount).toBeGreaterThanOrEqual(2);
      expect(stats.refreshErrors).toBe(0);
    } finally {
      handle.close();
    }
  });

  test("close stops the periodic refresher", async () => {
    const handle = openSearchSnapshotHandle(path, {
      refreshIntervalMs: 25,
    });
    await new Promise((r) => setTimeout(r, 60));
    const before = handle.stats().refreshCount;
    handle.close();
    await new Promise((r) => setTimeout(r, 80));
    // No further refreshes after close.
    expect(handle.stats().refreshCount).toBe(before);
  });

  test("refresh after close throws", async () => {
    const handle = openSearchSnapshotHandle(path, {});
    handle.close();
    await expect(handle.refresh()).rejects.toThrow(/closed/i);
  });

  test("holdSnapshot=false sees writer commits immediately (no isolation)", async () => {
    const handle = openSearchSnapshotHandle(path, {
      holdSnapshot: false,
    });
    try {
      const before = handle.db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number };
      expect(before.c).toBe(1);

      // Writer commits a new row.
      upsertChunks(writer, [
        chunk({ id: "live1", documentId: "doc-live1", embedding: randVec(99) }),
      ]);

      // Without snapshot isolation, the new row is immediately visible.
      const after = handle.db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number };
      expect(after.c).toBe(2);
    } finally {
      handle.close();
    }
  });

  test("holdSnapshot=false: refresh() is a no-op that bumps stats", async () => {
    const handle = openSearchSnapshotHandle(path, {
      holdSnapshot: false,
    });
    try {
      await handle.refresh();
      await handle.refresh();
      expect(handle.stats().refreshCount).toBe(2);
      expect(handle.stats().refreshErrors).toBe(0);
    } finally {
      handle.close();
    }
  });

  test("holdSnapshot=false: close() does not throw on missing txn", () => {
    const handle = openSearchSnapshotHandle(path, {
      holdSnapshot: false,
    });
    expect(() => handle.close()).not.toThrow();
  });
});
