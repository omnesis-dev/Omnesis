// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { inspectWindowsPrivatePaths, type WindowsPrivatePath } from "../windows-private-file.js";
import type { SecurityData, SecurityPermissionEntry } from "./types.js";

type PermissionData = Pick<
  SecurityData,
  "permissionEntries" | "permissionScanTruncated" | "permissionModel" | "permissionScanCount"
>;

/** Inspect native ACLs in bounded batches; safe entries do not consume the finding budget. */
export async function collectWindowsPermissionData(
  configDir: string,
  fixPermissions: boolean,
  maxEntries: number,
  inspect: typeof inspectWindowsPrivatePaths = inspectWindowsPrivatePaths,
): Promise<PermissionData> {
  const permissionEntries: SecurityPermissionEntry[] = [];
  let permissionScanTruncated = false;
  let permissionScanCount = 0;
  const pending = [configDir];
  const paths: WindowsPrivatePath[] = [];
  const inspected: SecurityPermissionEntry[] = [];
  const finding = (entry: SecurityPermissionEntry): void => {
    if (entry.ok && !entry.fixed) return;
    if (permissionEntries.length >= maxEntries) permissionScanTruncated = true;
    else permissionEntries.push(entry);
  };
  const flush = async (): Promise<void> => {
    if (paths.length === 0) return;
    try {
      const results = await inspect([...paths], { repair: fixPermissions });
      if (results.length !== inspected.length) throw new Error("Incomplete Windows ACL evidence");
      permissionScanCount += results.length;
      for (let index = 0; index < inspected.length; index++) {
        const entry = inspected[index]!;
        const result = results[index]!;
        entry.ok = result.private && entry.error === undefined;
        entry.fixed = result.fixed && result.private;
        if (!result.private) entry.error ??= "Windows access controls are not private";
      }
    } catch {
      for (const entry of inspected) {
        entry.ok = false;
        entry.fixed = false;
        entry.error ??= "Windows access control inspection failed";
      }
    }
    for (const entry of inspected) finding(entry);
    paths.length = 0;
    inspected.length = 0;
  };
  while (pending.length > 0) {
    const path = pending.pop()!;
    const entry: SecurityPermissionEntry = {
      path,
      relativePath: relative(configDir, path).replaceAll("\\", "/") || ".",
      kind: "other",
      expectedMode: null,
      actualMode: null,
      ok: false,
      fixed: false,
    };
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") entry.kind = "missing";
      entry.error = "Path could not be inspected";
      finding(entry);
      continue;
    }
    entry.kind = st.isSymbolicLink()
      ? "symlink"
      : st.isDirectory()
        ? "directory"
        : st.isFile()
          ? "file"
          : "other";
    if (entry.kind !== "file" && entry.kind !== "directory") {
      entry.error = "Links and special files require manual review";
      finding(entry);
      continue;
    }
    paths.push({ path, kind: entry.kind });
    inspected.push(entry);
    if (entry.kind === "directory") {
      try {
        const children = readdirSync(path).sort().reverse();
        for (const child of children) pending.push(join(path, child));
      } catch {
        entry.error = "Directory contents could not be inspected; rerun after repairing access";
      }
    }
    if (paths.length >= maxEntries) await flush();
  }
  await flush();
  return {
    permissionModel: "windows-acl",
    permissionEntries,
    permissionScanTruncated,
    permissionScanCount,
  };
}
