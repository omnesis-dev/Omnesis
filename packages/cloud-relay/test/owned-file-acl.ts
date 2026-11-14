// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { execWindowsJob, inspectWindowsPrivatePathSync } from "@omnesis/core";

/** Introduce one reviewed grant on an owned fixture, then restore its captured DACL explicitly. */
export async function exposeOwnedFixtureRead(input: string) {
  assert.equal(process.platform, "win32");
  const path = resolve(input);
  const identity = lstatSync(path, { bigint: true });
  assert.ok(identity.isFile() && !identity.isSymbolicLink());
  assert.equal(identity.nlink, 1n);
  const wasPrivate = inspectWindowsPrivatePathSync(path, "file").private;
  const checkIdentity = () => {
    const current = lstatSync(path, { bigint: true });
    assert.ok(current.isFile() && !current.isSymbolicLink());
    assert.deepEqual(
      [current.dev, current.ino, current.birthtimeNs],
      [identity.dev, identity.ino, identity.birthtimeNs],
    );
  };
  const run = async (script: string, sddl = "") => {
    checkIdentity();
    const result = await execWindowsJob(
      join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop';" + script,
      ],
      {
        timeout: 20_000,
        env: { ...process.env, OMNESIS_FIXTURE_ACL_PATH: path, OMNESIS_FIXTURE_ACL_SDDL: sddl },
      },
    );
    checkIdentity();
    return String(result.stdout).trim();
  };
  const snapshot = () =>
    run(
      "[Console]::Write([IO.File]::GetAccessControl($env:OMNESIS_FIXTURE_ACL_PATH).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Access'))",
    );
  const original = await snapshot();
  const restore = async () => {
    await run(
      "$acl=[IO.File]::GetAccessControl($env:OMNESIS_FIXTURE_ACL_PATH);$acl.SetSecurityDescriptorSddlForm($env:OMNESIS_FIXTURE_ACL_SDDL,[Security.AccessControl.AccessControlSections]::Access);[IO.File]::SetAccessControl($env:OMNESIS_FIXTURE_ACL_PATH,$acl)",
      original,
    );
    assert.equal(await snapshot(), original);
    assert.equal(inspectWindowsPrivatePathSync(path, "file").private, wasPrivate);
  };
  try {
    await execWindowsJob(
      join(process.env.SystemRoot!, "System32", "icacls.exe"),
      [path, "/grant", "*S-1-1-0:(R)", "/Q"],
      { timeout: 20_000 },
    );
    const exposed = await snapshot();
    assert.notEqual(exposed, original);
    assert.equal(inspectWindowsPrivatePathSync(path, "file").private, false);
    return { exposed, snapshot, restore };
  } catch (error) {
    if (error !== null && typeof error === "object" && Object.hasOwn(error, "cleanupFailure"))
      throw error;
    await restore();
    throw error;
  }
}
