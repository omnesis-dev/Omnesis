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

describe.skipIf(process.platform !== "win32")("Windows private atomic publication", () => {
  test("protects binary secrets under a readable parent through both replacements", async () => {
    const root = await readableParent();
    const path = join(root, "secret & $() 雪.bin");
    writeFileSync(path, "invented existing content");
    expect(inspectWindowsPrivatePathSync(path, "file").private).toBe(false);
    secureWindowsPrivatePathSync(path, "file");
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
