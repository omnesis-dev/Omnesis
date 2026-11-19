// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertStorageVolumeGrowth, measureStorageVolumes } from "./volumes.js";

describe("volume measurements", () => {
  it("deduplicates stores and resolves missing stores and symlinked locations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "storage-volumes-"));
    try {
      await symlink(dir, join(dir, "link"));
      const volumes = await measureStorageVolumes([
        dir,
        join(dir, "missing", "index.db"),
        join(dir, "link"),
      ]);
      expect(volumes).toHaveLength(1);
      expect(volumes[0]!.totalBytes).toBeGreaterThan(0);
      expect(volumes[0]!.availableBytes).toBeGreaterThanOrEqual(0);
      expect(volumes[0]!.availableBytes).toBeLessThanOrEqual(volumes[0]!.totalBytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces inaccessible or invalid paths instead of reporting infinite space", async () => {
    const dir = await mkdtemp(join(tmpdir(), "storage-volumes-"));
    try {
      const file = join(dir, "plain");
      await writeFile(file, "x");
      await expect(measureStorageVolumes([join(file, "invalid")])).rejects.toMatchObject({
        code: "ENOTDIR",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("live model volume admission", () => {
  const policy = { minFreeBytes: 100, maxDiskUsedPercent: 95 };
  it("checks reserve and used percentage against planned remaining bytes", () => {
    const roomy = () => ({ blocks: 10000, bavail: 5000, bsize: 1 });
    expect(() => assertStorageVolumeGrowth("/example", policy, 0, roomy)).not.toThrow();
    expect(() => assertStorageVolumeGrowth("/example", policy, 4600, roomy)).toThrow(
      /Not enough disk/,
    );
    const tiny = () => ({ blocks: 1000, bavail: 200, bsize: 1 });
    expect(() => assertStorageVolumeGrowth("/example", policy, 101, tiny)).toThrow(
      /Not enough disk/,
    );
    expect(() => assertStorageVolumeGrowth("/example", policy, 100, tiny)).not.toThrow();
  });

  it("fails closed on probe failure and invalid capacity", () => {
    expect(() =>
      assertStorageVolumeGrowth("/example", policy, 0, () => {
        throw new Error("probe unavailable");
      }),
    ).toThrow(/cannot be verified/);
    expect(() =>
      assertStorageVolumeGrowth("/example", policy, 0, () => ({
        blocks: 1000,
        bavail: Infinity,
        bsize: 1,
      })),
    ).toThrow(/cannot be verified/);
  });

  it("measures a missing model directory at its existing ancestor", () => {
    const paths: string[] = [];
    assertStorageVolumeGrowth("/example/missing", policy, 0, (path) => {
      paths.push(path);
      if (path.endsWith("missing")) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return { blocks: 10000, bavail: 5000, bsize: 1 };
    });
    expect(paths).toEqual(["/example/missing", "/example"]);
  });
});
