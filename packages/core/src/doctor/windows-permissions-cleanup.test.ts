// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { collectWindowsPermissionData } from "./windows-permissions.js";
import type { inspectWindowsPrivatePaths } from "../windows-private-file.js";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "doctor-acl-join-"));
  roots.push(root);
  writeFileSync(join(root, "first"), "invented first bytes");
  writeFileSync(join(root, "second"), "invented second bytes");
  return root;
}
afterEach(() => {
  // The inspector seam below starts no native worker.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([false, true])(
  "an unjoined ACL batch cannot authorize another repair (nested:%s)",
  async (nested) => {
    const root = fixture();
    const marker = { cleanupFailure: undefined };
    const error = nested ? new Error("Invented ACL helper failure", { cause: marker }) : marker;
    const inspect = vi
      .fn<typeof inspectWindowsPrivatePaths>()
      .mockRejectedValueOnce(error)
      .mockImplementation(async (paths) => paths.map(() => ({ private: true, fixed: true })));
    await expect(collectWindowsPermissionData(root, true, 1, inspect)).rejects.toBe(error);
    expect(inspect).toHaveBeenCalledExactlyOnceWith([{ path: root, kind: "directory" }], {
      repair: true,
    });
  },
);

test("a joined ordinary ACL failure remains a report and permits independent later batches", async () => {
  const root = fixture();
  const inspect = vi
    .fn<typeof inspectWindowsPrivatePaths>()
    .mockRejectedValueOnce(new Error("Invented joined ACL failure"))
    .mockImplementation(async (paths) => paths.map(() => ({ private: true, fixed: true })));
  const report = await collectWindowsPermissionData(root, true, 1, inspect);
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(inspect.mock.calls.every(([, options]) => options?.repair === true)).toBe(true);
  expect(report.permissionEntries[0]).toMatchObject({
    relativePath: ".",
    ok: false,
    fixed: false,
    error: "Windows access control inspection failed",
  });
});
