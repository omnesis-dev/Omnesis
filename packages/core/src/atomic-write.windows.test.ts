// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import * as childProcess from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, test, vi } from "vitest";
import { atomicWriteFile, atomicWriteFileSync } from "./atomic-write.js";
import { execWindowsJob } from "./windows-job-exec.js";
import {
  inspectWindowsPrivatePathSync,
  secureWindowsPrivatePathSync,
} from "./windows-private-file.js";
import { windowsPowerShellExecutable } from "./windows-process-tree.js";

vi.mock("node:child_process", async (actual) => ({
  ...(await actual<typeof import("node:child_process")>()),
}));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function readableParent(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "private-atomic-acl-"));
  roots.push(root);
  await execWindowsJob(
    windowsPowerShellExecutable(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
$ErrorActionPreference='Stop'
$path=$env:OMNESIS_ATOMIC_ACL_TEST
$acl=[System.IO.Directory]::GetAccessControl($path)
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]'S-1-1-0',[System.Security.AccessControl.FileSystemRights]::ReadAndExecute,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($path,$acl)
`,
    ],
    { env: { ...process.env, OMNESIS_ATOMIC_ACL_TEST: root }, timeout: 20_000 },
  );
  return root;
}

/** Inspect or explicitly review only this fixture's deliberately inherited grant. */
async function fixtureFileAcl(path: string, review = false): Promise<string> {
  const { stdout } = await execWindowsJob(
    windowsPowerShellExecutable(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
$ErrorActionPreference='Stop'
$path=$env:OMNESIS_ATOMIC_ACL_TEST
$sections=[System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group
$acl=[System.IO.File]::GetAccessControl($path,$sections)
if($env:OMNESIS_ATOMIC_REVIEW -eq '1') {
 $acl.SetAccessRuleProtection($true,$true)
 $acl.PurgeAccessRules([System.Security.Principal.SecurityIdentifier]'S-1-1-0')
 [System.IO.File]::SetAccessControl($path,$acl)
 $acl=[System.IO.File]::GetAccessControl($path,$sections)
}
[Console]::Out.Write($acl.GetSecurityDescriptorSddlForm($sections))
`,
    ],
    {
      env: {
        ...process.env,
        OMNESIS_ATOMIC_ACL_TEST: path,
        OMNESIS_ATOMIC_REVIEW: review ? "1" : "0",
      },
      timeout: 20_000,
    },
  );
  expect(stdout.trim().length).toBeGreaterThan(10);
  return stdout.trim();
}

describe.skipIf(process.platform !== "win32")("Windows private atomic publication", () => {
  test("protects binary secrets under a readable parent through both replacements", async () => {
    const root = await readableParent();
    const path = join(root, "secret & $() 雪.bin");
    writeFileSync(path, "invented existing content");
    const before = statSync(path, { bigint: true });
    const beforeAcl = await fixtureFileAcl(path);
    expect(inspectWindowsPrivatePathSync(path, "file").private).toBe(false);
    expect(() => secureWindowsPrivatePathSync(path, "file")).toThrow(/cannot be repaired online/u);
    expect(readFileSync(path, "utf8")).toBe("invented existing content");
    expect(await fixtureFileAcl(path)).toBe(beforeAcl);
    expect(statSync(path, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino });
    // The fixture operator reviews its invented Everyone grant explicitly;
    // the product must never make this unsafe online permission change.
    await fixtureFileAcl(path, true);
    secureWindowsPrivatePathSync(path, "file");
    expect(readFileSync(path, "utf8")).toBe("invented existing content");
    expect(statSync(path, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino });
    const bytes = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
    const syncLaunch = vi.spyOn(childProcess, "spawnSync");
    const asyncLaunch = vi.spyOn(childProcess, "spawn");
    const syncStart = performance.now();
    atomicWriteFileSync(path, bytes, { mode: 0o600 });
    const syncMs = performance.now() - syncStart;
    const syncStarts = syncLaunch.mock.calls.length;
    expect(readFileSync(path)).toEqual(bytes);
    expect(inspectWindowsPrivatePathSync(path, "file").private).toBe(true);
    bytes.reverse();
    const asyncStart = performance.now();
    await atomicWriteFile(path, bytes, { mode: 0o600 });
    const asyncMs = performance.now() - asyncStart;
    const asyncStarts = asyncLaunch.mock.calls.length;
    expect(readFileSync(path)).toEqual(bytes);
    expect(inspectWindowsPrivatePathSync(path, "file").private).toBe(true);
    expect(readdirSync(root)).toEqual(["secret & $() 雪.bin"]);
    process.stdout.write(
      `Windows private atomic timing ${JSON.stringify({ syncMs, asyncMs, syncStarts, asyncStarts })}\n`,
    );
  }, 60_000);

  test("preserves private read-only mode and can replace its read-only target", async () => {
    const root = await readableParent();
    const path = join(root, "read-only-secret");
    atomicWriteFileSync(path, "first invented secret", { mode: 0o400 });
    expect(statSync(path).mode & 0o200).toBe(0);
    expect(inspectWindowsPrivatePathSync(path, "file").private).toBe(true);
    await atomicWriteFile(path, "second invented secret", { mode: 0o600 });
    expect(readFileSync(path, "utf8")).toBe("second invented secret");
    expect(statSync(path).mode & 0o200).not.toBe(0);
    expect(inspectWindowsPrivatePathSync(path, "file").private).toBe(true);
  }, 60_000);
});
