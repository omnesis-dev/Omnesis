// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";
import { measureDiskUsage, type DiskUsageLayout } from "./disk-usage.js";

const entries = vi.hoisted(
  () => new Map<string, { directory: boolean; inode: bigint; size: number }>(),
);
vi.mock("node:fs/promises", () => ({
  realpath: (path: string) =>
    entries.has(path) ? Promise.resolve(path) : Promise.reject(new Error("missing fixture entry")),
  readdir: (path: string) =>
    Promise.resolve(
      [...entries.keys()]
        .filter(
          (entry) => entry.startsWith(path + sep) && !entry.slice(path.length + 1).includes(sep),
        )
        .map((entry) => entry.slice(path.length + 1)),
    ),
  lstat: (path: string, options?: { bigint?: boolean }) => {
    const entry = entries.get(path);
    if (!entry) return Promise.reject(new Error("missing fixture entry"));
    return Promise.resolve({
      dev: options?.bigint ? 1n : 1,
      ino: options?.bigint ? entry.inode : Number(entry.inode),
      size: options?.bigint ? BigInt(entry.size) : entry.size,
      isDirectory: () => entry.directory,
      isFile: () => !entry.directory,
    });
  },
}));

describe("disk usage with large filesystem identities", () => {
  test("counts distinct 64-bit file IDs and deduplicates only actual hard-link identities", async () => {
    entries.clear();
    const configDir = join(tmpdir(), "invented-disk-identity");
    entries.set(configDir, { directory: true, inode: 1n, size: 0 });
    const first = 9_007_199_254_740_992n;
    entries.set(join(configDir, "omnesis.db"), { directory: false, inode: first, size: 100 });
    entries.set(join(configDir, "omnesis.db-wal"), {
      directory: false,
      inode: first + 1n,
      size: 60,
    });
    entries.set(join(configDir, "linked.db"), { directory: false, inode: first, size: 100 });
    const layout: DiskUsageLayout = {
      configDir,
      dbPath: join(configDir, "omnesis.db"),
      indexDbPath: join(configDir, "index.db"),
      analyticsDbPath: join(configDir, "analytics.db"),
      watchDbPath: join(configDir, "watch.db"),
      transcriptsDir: join(configDir, "transcripts"),
      conversationsDir: join(configDir, "conversations"),
      modelsDir: join(configDir, "models"),
      backupsDir: join(configDir, "backups"),
    };
    const result = await measureDiskUsage(layout);
    expect(result.totalBytes).toBe(160);
    expect(result.stores).toEqual([{ id: "documents", label: "Main database", bytes: 160 }]);
  });
});
