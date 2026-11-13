// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execWindowsJob } from "./windows-job-exec.js";
import { createWindowsPrivateFile, readWindowsPrivateFile } from "./windows-private-file.js";
import { windowsPowerShellExecutable } from "./windows-process-tree.js";

describe.skipIf(process.platform !== "win32")("Windows private file handle and ACL", () => {
  it("creates a private ACL before writing and accepts literal special-character paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "windows-private-file-"));
    const path = join(dir, "private & $() 雪.key");
    const bytes = Buffer.from("invented key material\n");
    try {
      await createWindowsPrivateFile(path, bytes);
      expect(await readWindowsPrivateFile(path)).toEqual(bytes);
      await expect(
        createWindowsPrivateFile(path, Buffer.from("replacement")),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(path)).toEqual(bytes);
      await expect(readWindowsPrivateFile(join(dir, "missing"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects broad allow rules on an existing key without changing or reading its bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "windows-private-acl-"));
    const path = join(dir, "private.key");
    try {
      await createWindowsPrivateFile(path, Buffer.from("invented private bytes"));
      await execWindowsJob(
        windowsPowerShellExecutable(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `
$path=$env:OMNESIS_PRIVATE_ACL_TEST;
$acl=[System.IO.File]::GetAccessControl($path);
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]'S-1-1-0',[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow);
$acl.AddAccessRule($rule);[System.IO.File]::SetAccessControl($path,$acl);
`,
        ],
        { env: { ...process.env, OMNESIS_PRIVATE_ACL_TEST: path }, timeout: 20_000 },
      );
      await expect(readWindowsPrivateFile(path)).rejects.toMatchObject({ code: "EPRIVATE" });
      expect(await readFile(path, "utf8")).toBe("invented private bytes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects leaf reparse points, directories and oversized files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "windows-private-reparse-"));
    const path = join(dir, "private.key"),
      alias = join(dir, "alias.key");
    try {
      await createWindowsPrivateFile(path, Buffer.from("invented material"));
      await symlink(path, alias);
      await expect(readWindowsPrivateFile(alias)).rejects.toMatchObject({ code: "EPRIVATE" });
      await expect(readWindowsPrivateFile(dir)).rejects.toMatchObject({ code: "EPRIVATE" });
      await writeFile(path, Buffer.alloc(16_385));
      await expect(readWindowsPrivateFile(path)).rejects.toMatchObject({ code: "EPRIVATE" });
      await expect(
        createWindowsPrivateFile(join(dir, "oversized"), Buffer.alloc(16_385)),
      ).rejects.toThrow("too large");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
