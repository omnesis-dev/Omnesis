// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  inspectWindowsPrivatePathSync,
  prepareWindowsPrivateStorageDirectorySync,
  secureWindowsPrivatePathSync,
} from "./windows-private-file.js";
import { execWindowsJob } from "./windows-job-exec.js";
import { windowsPowerShellExecutable } from "./windows-powershell.js";
let root: string;
async function descriptor(path: string, nonInheriting = false): Promise<string> {
  const result = await execWindowsJob(
    windowsPowerShellExecutable(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
$ErrorActionPreference='Stop';$PSModuleAutoLoadingPreference='None';$path=$env:OMNESIS_STORAGE_FIXTURE;
if($env:OMNESIS_STORAGE_NO_INHERIT -eq '1') {
 $acl=[Security.AccessControl.DirectorySecurity]::new();$user=[Security.Principal.WindowsIdentity]::GetCurrent().User;
 $acl.SetOwner($user);$acl.SetAccessRuleProtection($true,$false);
 foreach($sid in @($user.Value,'S-1-5-18','S-1-5-32-544')) {$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]$sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow));}
 [IO.Directory]::SetAccessControl($path,$acl);
}
$sections=[Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group;
[Console]::Out.Write([IO.Directory]::GetAccessControl($path,$sections).GetSecurityDescriptorSddlForm($sections));
`,
    ],
    {
      env: {
        ...process.env,
        OMNESIS_STORAGE_FIXTURE: path,
        OMNESIS_STORAGE_NO_INHERIT: nonInheriting ? "1" : "0",
      },
      timeout: 20_000,
    },
  );
  return result.stdout.trim();
}
describe.runIf(process.platform === "win32")("private Windows storage directories", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "private-storage-"));
    secureWindowsPrivatePathSync(root, "directory");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  it("creates only a new private suffix and protects ordinary future file creation before bytes", () => {
    const directory = join(root, "new", "state");
    prepareWindowsPrivateStorageDirectorySync(directory);
    expect(inspectWindowsPrivatePathSync(directory, "directory").private).toBe(true);
    expect(readdirSync(directory)).toEqual([]);
    const file = join(directory, "ordinary.db"),
      fd = openSync(file, "wx", 0o666);
    try {
      expect(inspectWindowsPrivatePathSync(file, "file").private).toBe(true);
      writeSync(fd, "invented private bytes");
    } finally {
      closeSync(fd);
    }
    expect(readdirSync(directory)).toEqual(["ordinary.db"]);
  });
  it("refuses a private but non-inheriting existing directory without rewriting its DACL or leaving a probe", async () => {
    const directory = join(root, "existing");
    mkdirSync(directory);
    const before = await descriptor(directory, true);
    expect(inspectWindowsPrivatePathSync(directory, "directory").private).toBe(true);
    expect(() => prepareWindowsPrivateStorageDirectorySync(directory)).toThrow();
    expect(await descriptor(directory)).toBe(before);
    expect(readdirSync(directory)).toEqual([]);
  });
  it("rejects a foreign-writable higher ancestor even when immediate private parents are safe", async () => {
    const shared = join(root, "shared"),
      bridge = join(shared, "bridge"),
      directory = join(bridge, "state");
    prepareWindowsPrivateStorageDirectorySync(directory);
    const before = await descriptor(directory);
    execFileSync(
      join(process.env.SystemRoot!, "System32", "icacls.exe"),
      [shared, "/grant", "*S-1-1-0:(M)"],
      { windowsHide: true, timeout: 10_000 },
    );
    expect(inspectWindowsPrivatePathSync(directory, "directory").private).toBe(true);
    expect(() => prepareWindowsPrivateStorageDirectorySync(directory)).toThrow();
    expect(await descriptor(directory)).toBe(before);
    expect(readdirSync(directory)).toEqual([]);
  });
  it("never creates a missing suffix through an intermediate junction", () => {
    const external = join(root, "external"),
      alias = join(root, "alias");
    mkdirSync(external);
    symlinkSync(external, alias, "junction");
    expect(() =>
      prepareWindowsPrivateStorageDirectorySync(join(alias, "must-not-create")),
    ).toThrow();
    expect(readdirSync(external)).toEqual([]);
  });
});
