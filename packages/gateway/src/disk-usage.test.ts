// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DiskUsageMonitor, measureDiskUsage, type DiskUsageLayout } from "./disk-usage.js";
import type { DiskUsageSnapshot } from "@omnesis/core/doctor";

let root: string;
let configDir: string;

function file(path: string, bytes: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
}

function layout(overrides: Partial<DiskUsageLayout> = {}): DiskUsageLayout {
  return {
    configDir,
    dbPath: join(configDir, "omnesis.db"),
    indexDbPath: join(configDir, "index.db"),
    analyticsDbPath: join(configDir, "analytics.db"),
    watchDbPath: join(configDir, "watch.db"),
    transcriptsDir: join(configDir, "briefs", "transcripts"),
    conversationsDir: join(configDir, "conversations"),
    modelsDir: join(configDir, "models"),
    backupsDir: join(configDir, "backups"),
    ...overrides,
  };
}

function bytesOf(snapshot: DiskUsageSnapshot): Record<string, number> {
  for (const store of snapshot.stores) {
    if (store.components)
      expect(store.components.reduce((sum, component) => sum + component.bytes, 0)).toBe(
        store.bytes,
      );
  }
  return Object.fromEntries(snapshot.stores.map((s) => [s.id, s.bytes]));
}

function componentsOf(snapshot: DiskUsageSnapshot, storeId: string): Record<string, number> {
  return Object.fromEntries(
    snapshot.stores
      .find((store) => store.id === storeId)
      ?.components?.map((c) => [c.id, c.bytes]) ?? [],
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omnesis-disk-usage-"));
  configDir = join(root, "config");
  mkdirSync(configDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("measureDiskUsage", () => {
  test("strict quota measurement propagates unreadable store paths", async () => {
    const plain = join(root, "not-a-directory");
    file(plain, 1);
    const invalid = layout({ dbPath: join(plain, "omnesis.db") });
    await expect(
      measureDiskUsage(invalid, () => new Date(), { strict: true }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(measureDiskUsage(invalid)).resolves.toBeDefined();
  });

  test("strict quota measurement still tolerates stores absent on a fresh install", async () => {
    const snapshot = await measureDiskUsage(layout(), () => new Date(), { strict: true });
    expect(snapshot.totalBytes).toBe(0);
  });

  test("counts every store with its sidecars and puts the rest under other", async () => {
    file(join(configDir, "omnesis.db"), 1000);
    file(join(configDir, "omnesis.db-wal"), 100);
    file(join(configDir, "omnesis.db-shm"), 10);
    file(join(configDir, "index.db"), 2000);
    file(join(configDir, "index.db-wal"), 200);
    file(join(configDir, "index.usearch"), 3000);
    file(join(configDir, "index.usearch.enc"), 3000);
    file(join(configDir, "index-2.usearch"), 500);
    file(join(configDir, "analytics.db"), 4000);
    file(join(configDir, "analytics.db.wal"), 40);
    file(join(configDir, "analytics.db.tmp", "stage", "spill.bin"), 4);
    file(join(configDir, "analytics.db.extensions", "httpfs.ext"), 400);
    file(join(configDir, "watch.db"), 50);
    file(join(configDir, "watch.db-wal"), 5);
    file(join(configDir, "briefs", "transcripts", "run-1.json"), 60);
    file(join(configDir, "conversations", "c-1.json"), 70);
    file(join(configDir, "models", "embed.gguf"), 8000);
    file(join(configDir, "backups", "2026-01-01T00-00-00", "omnesis.db"), 900);
    file(join(configDir, "omnesis.json"), 7);
    file(join(configDir, "tls", "cert.pem"), 3);
    // A copy the operator made by hand is not the live database.
    file(join(configDir, "omnesis.db.bak"), 20);

    const snapshot = await measureDiskUsage(layout(), () => new Date("2026-06-04T10:00:00Z"));

    expect(bytesOf(snapshot)).toEqual({
      documents: 1110,
      index: 8700,
      analytics: 4444,
      watch: 55,
      transcripts: 60,
      conversations: 70,
      models: 8000,
      backups: 900,
      other: 30,
    });
    expect(snapshot.totalBytes).toBe(1110 + 8700 + 4444 + 55 + 60 + 70 + 8000 + 900 + 30);
    expect(snapshot.measuredAt).toBe("2026-06-04T10:00:00.000Z");
    expect(snapshot.stores.map((s) => s.id)).toEqual([
      "documents",
      "index",
      "analytics",
      "watch",
      "transcripts",
      "conversations",
      "models",
      "backups",
      "other",
    ]);
    expect(snapshot.stores[0]!.label).toBe("Main database");
    expect(componentsOf(snapshot, "documents")).toEqual({
      database: 1000,
      "write-log": 100,
      coordination: 10,
    });
    expect(componentsOf(snapshot, "index")).toEqual({
      database: 2000,
      "write-log": 200,
      graph: 6500,
    });
    expect(componentsOf(snapshot, "analytics")).toEqual({
      database: 4000,
      "write-log": 40,
      spill: 4,
      extensions: 400,
    });
    expect(componentsOf(snapshot, "watch")).toEqual({ database: 50, "write-log": 5 });
    for (const id of ["transcripts", "conversations", "models", "backups", "other"])
      expect(snapshot.stores.find((store) => store.id === id)?.components).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain(configDir);
  });

  test("omits empty parts and reports zero for a missing config dir", async () => {
    file(join(configDir, "omnesis.db"), 10);
    expect((await measureDiskUsage(layout())).stores).toEqual([
      {
        id: "documents",
        label: "Main database",
        bytes: 10,
        components: [{ id: "database", label: "Database file", bytes: 10 }],
      },
    ]);

    const empty = await measureDiskUsage(layout({ configDir: join(root, "absent") }));
    expect(empty.totalBytes).toBe(10); // the store paths still point at the real db
    const none = await measureDiskUsage({
      ...layout({ configDir: join(root, "absent") }),
      dbPath: join(root, "absent", "omnesis.db"),
    });
    expect(none).toMatchObject({ totalBytes: 0, stores: [] });
  });

  test("counts a store moved outside the config dir under its own part", async () => {
    const elsewhere = join(root, "fast-disk", "index.db");
    file(elsewhere, 600);
    file(`${elsewhere}-wal`, 60);
    file(join(configDir, "omnesis.db"), 10);

    const snapshot = await measureDiskUsage(layout({ indexDbPath: elsewhere }));

    expect(bytesOf(snapshot)).toEqual({ documents: 10, index: 660 });
  });

  test("never counts a hard-linked file twice and follows only a symlinked root", async () => {
    file(join(configDir, "omnesis.db"), 100);
    linkSync(join(configDir, "omnesis.db"), join(configDir, "omnesis-hardlink.db"));
    file(join(root, "shared-models", "big.gguf"), 5000);
    symlinkSync(join(root, "shared-models"), join(configDir, "models"));
    symlinkSync(join(root, "shared-models", "big.gguf"), join(configDir, "linked.gguf"));

    const snapshot = await measureDiskUsage(layout());

    // models/ is measured where it points; the stray link below the root is not followed.
    expect(bytesOf(snapshot)).toEqual({ documents: 100, models: 5000 });
  });

  test("groups journal and WAL once and omits missing or zero-byte components", async () => {
    file(join(configDir, "omnesis.db"), 100);
    file(join(configDir, "omnesis.db-wal"), 20);
    file(join(configDir, "omnesis.db-journal"), 30);
    file(join(configDir, "omnesis.db-shm"), 0);
    const snapshot = await measureDiskUsage(layout(), () => new Date(), { strict: true });
    expect(bytesOf(snapshot)).toEqual({ documents: 150 });
    expect(snapshot.stores[0]!.components).toEqual([
      { id: "database", label: "Database file", bytes: 100 },
      { id: "write-log", label: "Write log", bytes: 50 },
    ]);
  });

  test("component ownership follows the same deduplication for aliases and external stores", async () => {
    const external = join(root, "external-store", "corpus.db");
    file(external, 100);
    symlinkSync(external, join(configDir, "omnesis.db"));
    linkSync(external, join(configDir, "omnesis.db-wal"));
    file(`${external}-wal`, 20);
    file(join(configDir, "index.usearch.enc"), 30);
    linkSync(join(configDir, "index.usearch.enc"), join(configDir, "index-2.usearch"));
    const snapshot = await measureDiskUsage(layout({ indexDbPath: external }));
    // The main store's root alias owns the shared database inode. Search owns
    // only its separate write log and the first link to its graph inode.
    expect(bytesOf(snapshot)).toEqual({ documents: 100, index: 50 });
    expect(componentsOf(snapshot, "documents")).toEqual({ database: 100 });
    expect(componentsOf(snapshot, "index")).toEqual({ "write-log": 20, graph: 30 });
    expect(JSON.stringify(snapshot)).not.toContain(root);
  });

  test("a shared engine path belongs wholly to its first store", async () => {
    const shared = join(configDir, "shared.db");
    file(shared, 100);
    file(`${shared}-wal`, 10);
    const snapshot = await measureDiskUsage(layout({ dbPath: shared, indexDbPath: shared }));
    expect(bytesOf(snapshot)).toEqual({ documents: 110 });
    expect(componentsOf(snapshot, "documents")).toEqual({ database: 100, "write-log": 10 });
  });

  test("measures a config dir reached through a symlink", async () => {
    file(join(configDir, "omnesis.db"), 100);
    file(join(configDir, "models", "embed.gguf"), 400);
    file(join(configDir, "omnesis.json"), 7);
    const linked = join(root, "linked-config");
    symlinkSync(configDir, linked);

    const snapshot = await measureDiskUsage({
      ...layout(),
      configDir: linked,
      dbPath: join(linked, "omnesis.db"),
      modelsDir: join(linked, "models"),
    });

    expect(bytesOf(snapshot)).toEqual({ documents: 100, models: 400, other: 7 });
  });
});

describe("DiskUsageMonitor", () => {
  function snapshotOf(totalBytes: number): DiskUsageSnapshot {
    return { totalBytes, measuredAt: "2026-06-04T10:00:00.000Z", stores: [] };
  }

  test("answers null until the first measurement lands, then serves it without re-measuring", async () => {
    let calls = 0;
    const monitor = new DiskUsageMonitor(() => Promise.resolve(snapshotOf(++calls)), {
      maxAgeMs: 1000,
      clock: () => 0,
    });

    expect(monitor.snapshot()).toBeNull();
    await monitor.refresh();
    expect(monitor.snapshot()?.totalBytes).toBe(1);
    expect(monitor.snapshot()?.totalBytes).toBe(1);
    expect(calls).toBe(1);
  });

  test("serves the stale value while one background refresh replaces it", async () => {
    let now = 0;
    let calls = 0;
    let release: (() => void) | undefined;
    const monitor = new DiskUsageMonitor(
      () => {
        calls += 1;
        if (calls === 1) return Promise.resolve(snapshotOf(1));
        return new Promise((done) => {
          release = () => done(snapshotOf(2));
        });
      },
      { maxAgeMs: 1000, clock: () => now },
    );
    await monitor.refresh();

    now = 1000;
    expect(monitor.snapshot()?.totalBytes).toBe(1);
    expect(monitor.snapshot()?.totalBytes).toBe(1);
    await Promise.resolve(); // the measurement starts on the next microtask
    expect(calls).toBe(2); // the second stale read joined the running measurement

    release!();
    await monitor.refresh();
    expect(monitor.snapshot()?.totalBytes).toBe(2);
  });

  test("a failing first measurement is retried only once it ages out", async () => {
    let now = 0;
    let calls = 0;
    const monitor = new DiskUsageMonitor(
      () => {
        calls += 1;
        return Promise.reject(new Error("unreadable"));
      },
      { maxAgeMs: 1000, clock: () => now },
    );

    expect(monitor.snapshot()).toBeNull();
    await monitor.refresh();
    expect(monitor.snapshot()).toBeNull();
    expect(calls).toBe(1);

    now = 1000;
    monitor.snapshot();
    await monitor.refresh();
    expect(calls).toBe(2);
  });

  test("a measure function that throws synchronously never escapes into the reader", async () => {
    const monitor = new DiskUsageMonitor(() => {
      throw new Error("boom");
    });
    expect(() => monitor.snapshot()).not.toThrow();
    await monitor.refresh();
    expect(monitor.snapshot()).toBeNull();
  });

  test("keeps the last value when a measurement fails and waits out the age before retrying", async () => {
    let now = 0;
    let calls = 0;
    const monitor = new DiskUsageMonitor(
      () => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error("disk vanished"));
        return Promise.resolve(snapshotOf(calls));
      },
      { maxAgeMs: 1000, clock: () => now },
    );
    await monitor.refresh();

    now = 1000;
    monitor.snapshot();
    await monitor.refresh(); // settles the failing run
    expect(monitor.snapshot()?.totalBytes).toBe(1);
    expect(calls).toBe(2);

    now = 2000;
    monitor.snapshot();
    await monitor.refresh();
    expect(monitor.snapshot()?.totalBytes).toBe(3);
  });
});
