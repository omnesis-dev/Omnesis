// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { collectWindowsPermissionData } from "./windows-permissions.js";
import type { inspectWindowsPrivatePaths } from "../windows-private-file.js";

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "windows-permissions-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Windows permission collection", () => {
  test("batches native evidence and keeps POSIX mode bits out of the verdict", async () => {
    const root = scratch();
    const token = join(root, "token");
    writeFileSync(token, "invented-token", { mode: 0o600 });
    const inspect = vi.fn<typeof inspectWindowsPrivatePaths>().mockResolvedValue([
      { private: true, fixed: false },
      { private: false, fixed: false },
    ]);
    const data = await collectWindowsPermissionData(root, false, 5000, inspect);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(
      [
        { path: root, kind: "directory" },
        { path: token, kind: "file" },
      ],
      { repair: false },
    );
    expect(data.permissionModel).toBe("windows-acl");
    expect(data.permissionScanCount).toBe(2);
    expect(data.permissionEntries).toMatchObject([
      { relativePath: "token", ok: false, actualMode: null, expectedMode: null },
    ]);
  });

  test("failed or incomplete native inspection never becomes a permission repair", async () => {
    const root = scratch();
    const inspect = vi.fn<typeof inspectWindowsPrivatePaths>();
    inspect.mockRejectedValueOnce(new Error("Native worker unavailable"));
    inspect.mockResolvedValueOnce([]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const data = await collectWindowsPermissionData(root, true, 5000, inspect);
      expect(data.permissionEntries).toMatchObject([
        { ok: false, fixed: false, error: "Windows access control inspection failed" },
      ]);
    }
  });

  test("only verified private results can report successful repairs", async () => {
    const root = scratch();
    writeFileSync(join(root, "token"), "invented-token");
    const inspect = vi.fn<typeof inspectWindowsPrivatePaths>().mockResolvedValue([
      { private: true, fixed: true },
      { private: false, fixed: true, error: "EPRIVATE" },
    ]);
    const data = await collectWindowsPermissionData(root, true, 5000, inspect);
    expect(data.permissionEntries).toMatchObject([
      { ok: true, fixed: true },
      { ok: false, fixed: false },
    ]);
  });

  test("does not follow directory links or inspect files outside the config tree", async () => {
    const root = scratch();
    const external = scratch();
    writeFileSync(join(external, "outside"), "invented unrelated content");
    symlinkSync(external, join(root, "alias"), "junction");
    const inspect = vi
      .fn<typeof inspectWindowsPrivatePaths>()
      .mockResolvedValue([{ private: true, fixed: false }]);
    const data = await collectWindowsPermissionData(root, true, 5000, inspect);
    expect(inspect).toHaveBeenCalledExactlyOnceWith([{ path: root, kind: "directory" }], {
      repair: true,
    });
    expect(data.permissionEntries).toMatchObject([
      { relativePath: "alias", kind: "symlink", ok: false },
    ]);
  });

  test("continues after a safe batch and reports later unsafe entries", async () => {
    const root = scratch();
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "token"), "invented-token");
    const inspect = vi
      .fn<typeof inspectWindowsPrivatePaths>()
      .mockResolvedValueOnce([
        { private: true, fixed: false },
        { private: true, fixed: false },
      ])
      .mockResolvedValueOnce([{ private: false, fixed: false }]);
    const data = await collectWindowsPermissionData(root, false, 2, inspect);
    expect(data.permissionScanTruncated).toBe(false);
    expect(data.permissionScanCount).toBe(3);
    expect(data.permissionEntries).toMatchObject([{ relativePath: "nested/token", ok: false }]);
    expect(inspect.mock.calls.map(([paths]) => paths.length)).toEqual([2, 1]);
  });

  test("limits findings without stopping the filesystem scan", async () => {
    const root = scratch();
    writeFileSync(join(root, "first"), "invented-token");
    writeFileSync(join(root, "second"), "invented-token");
    const inspect = vi
      .fn<typeof inspectWindowsPrivatePaths>()
      .mockImplementation(async (paths) => paths.map(() => ({ private: false, fixed: false })));
    const data = await collectWindowsPermissionData(root, false, 2, inspect);
    expect(data.permissionScanTruncated).toBe(true);
    expect(data.permissionScanCount).toBe(3);
    expect(data.permissionEntries).toHaveLength(2);
  });
});
