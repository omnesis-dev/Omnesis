// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ensurePrivateDirSync } from "../security-files.js";
import { execWindowsJob } from "../windows-job-exec.js";
import { windowsPowerShellExecutable } from "../windows-process-tree.js";
import { collectWindowsPermissionData } from "./windows-permissions.js";

describe.skipIf(process.platform !== "win32")("Windows doctor effective inherited ACLs", () => {
  test("accepts safe inherited files and detects unsafe inherited ACEs without repeated repairs", async () => {
    const root = mkdtempSync(join(tmpdir(), "windows-doctor-inherited-"));
    try {
      ensurePrivateDirSync(root);
      const safe = join(root, "safe.wal");
      const exposed = join(root, "exposed");
      writeFileSync(safe, "invented safe WAL bytes");
      mkdirSync(exposed);
      const result = await execWindowsJob(
        windowsPowerShellExecutable(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `
$ErrorActionPreference='Stop'
$safe=$env:OMNESIS_DOCTOR_SAFE_TEST
$path=$env:OMNESIS_DOCTOR_EXPOSED_TEST
$acl=[System.IO.Directory]::GetAccessControl($path)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]'S-1-1-0',[System.Security.AccessControl.FileSystemRights]::ReadAndExecute,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow))
[System.IO.Directory]::SetAccessControl($path,$acl)
[Console]::Out.Write((@{rootProtected=([System.IO.Directory]::GetAccessControl([System.IO.Path]::GetDirectoryName($safe))).AreAccessRulesProtected;safeProtected=([System.IO.File]::GetAccessControl($safe)).AreAccessRulesProtected}|ConvertTo-Json -Compress))
`,
        ],
        {
          env: {
            ...process.env,
            OMNESIS_DOCTOR_SAFE_TEST: safe,
            OMNESIS_DOCTOR_EXPOSED_TEST: exposed,
          },
          timeout: 20_000,
        },
      );
      expect(JSON.parse(result.stdout)).toEqual({ rootProtected: true, safeProtected: false });
      writeFileSync(join(exposed, "unsafe.wal"), "invented exposed WAL bytes");
      const before = await collectWindowsPermissionData(root, false, 5000);
      expect(before.permissionEntries.map((entry) => entry.relativePath).sort()).toEqual([
        "exposed",
        "exposed/unsafe.wal",
      ]);
      expect(before.permissionScanCount).toBe(4);
      const repaired = await collectWindowsPermissionData(root, true, 5000);
      expect(repaired.permissionEntries.every((entry) => entry.ok)).toBe(true);
      expect(repaired.permissionEntries.some((entry) => entry.fixed)).toBe(true);
      expect((await collectWindowsPermissionData(root, false, 5000)).permissionEntries).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }, 60_000);
});
