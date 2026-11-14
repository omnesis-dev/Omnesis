// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createPrivateScratch, createPrivateScratchAsync } from "./private-scratch.js";
import { inspectWindowsPrivatePaths } from "./windows-private-file.js";
import { execWindowsJob } from "./windows-job-exec.js";
import { windowsPowerShellExecutable } from "./windows-process-tree.js";

const state = vi.hoisted(() => ({ base: "", originalTmpdir: "" }));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  state.originalTmpdir = actual.tmpdir();
  return { ...actual, tmpdir: () => state.base || actual.tmpdir() };
});

afterEach(() => {
  if (state.base) rmSync(state.base, { recursive: true, force: true });
  state.base = "";
});

test.runIf(process.platform === "win32")(
  "scratch children and plaintext snapshots inherit a private ACL from a protected root",
  async () => {
    state.base = mkdtempSync(join(state.originalTmpdir, "windows-scratch-acl-"));
    const root = join(state.base, "omnesis-owned-scratch-user");
    mkdirSync(root);
    const exposed = await execWindowsJob(
      windowsPowerShellExecutable(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop';
$path=$env:OMNESIS_SCRATCH_ACL_TEST;
$acl=[System.IO.Directory]::GetAccessControl($path);
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]'S-1-1-0',[System.Security.AccessControl.FileSystemRights]::ReadAndExecute,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow));
[System.IO.Directory]::SetAccessControl($path,$acl);`,
      ],
      { env: { ...process.env, OMNESIS_SCRATCH_ACL_TEST: root }, timeout: 20_000 },
    );
    expect(exposed.stderr).toBe("");
    expect(
      (await inspectWindowsPrivatePaths([{ path: root, kind: "directory" }]))[0]?.private,
    ).toBe(false);
    const scratch = createPrivateScratch("snapshot");
    const asyncScratch = await createPrivateScratchAsync("ocr");
    try {
      const snapshot = join(scratch.path, "snapshot.db");
      writeFileSync(snapshot, "invented plaintext snapshot");
      const image = join(asyncScratch.path, "image.png");
      writeFileSync(image, "invented image bytes");
      const results = await inspectWindowsPrivatePaths([
        { path: root, kind: "directory" },
        { path: scratch.path, kind: "directory" },
        { path: snapshot, kind: "file" },
        { path: asyncScratch.path, kind: "directory" },
        { path: image, kind: "file" },
      ]);
      expect(results).toHaveLength(5);
      expect(results.every((entry) => entry.private && !entry.fixed)).toBe(true);
    } finally {
      scratch.cleanup();
      await asyncScratch.cleanup();
    }
  },
  60_000,
);
