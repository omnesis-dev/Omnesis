// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  execWindowsJob,
  inspectWindowsPrivatePathSync,
  readWindowsPrivateFile,
} from "@omnesis/core";
import { z } from "zod";

/** Introduce one reviewed grant on an owned fixture, then restore its captured DACL explicitly. */
export async function exposeOwnedFixtureRead(input: string) {
  assert.equal(process.platform, "win32");
  const path = resolve(input);
  const identity = lstatSync(path, { bigint: true });
  assert.ok(identity.isFile() && !identity.isSymbolicLink());
  assert.equal(identity.nlink, 1n);
  assert.equal(inspectWindowsPrivatePathSync(path, "file").private, true);
  const originalBytes = await readWindowsPrivateFile(path, 65_536);
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
  const capture = async () => {
    const output = await run(String.raw`
$acl=[IO.File]::GetAccessControl($env:OMNESIS_FIXTURE_ACL_PATH)
$sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Access')
$descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($sddl)
$protected=$acl.AreAccessRulesProtected
$flags=[int]$descriptor.ControlFlags
if ($protected) {
  $flags=$flags -band (-bnot [int]([Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited))
}
$aces=@(foreach ($ace in $descriptor.DiscretionaryAcl) {
  $bytes=[byte[]]::new($ace.BinaryLength)
  $ace.GetBinaryForm($bytes,0)
  if ($protected) {
    $bytes[1]=[byte]($bytes[1] -band (-bnot [int]([Security.AccessControl.AceFlags]::Inherited)))
  }
  [Convert]::ToBase64String($bytes)
})
[Console]::Write((@{sddl=$sddl;owner=$descriptor.Owner.Value;protected=$protected;canonical=$acl.AreAccessRulesCanonical;flags=$flags;aces=$aces} | ConvertTo-Json -Compress))
`);
    return z
      .object({
        sddl: z.string().min(1),
        owner: z.string().min(1),
        protected: z.boolean(),
        canonical: z.boolean(),
        flags: z.number().int(),
        aces: z.array(z.string()),
      })
      .strict()
      .parse(JSON.parse(output));
  };
  const snapshot = async () => (await capture()).sddl;
  const original = await capture();
  assert.equal(original.canonical, true);
  const restore = async () => {
    await run(
      "$acl=[IO.File]::GetAccessControl($env:OMNESIS_FIXTURE_ACL_PATH);$acl.SetSecurityDescriptorSddlForm($env:OMNESIS_FIXTURE_ACL_SDDL,[Security.AccessControl.AccessControlSections]::Access);[IO.File]::SetAccessControl($env:OMNESIS_FIXTURE_ACL_PATH,$acl)",
      original.sddl,
    );
    const restored = await capture();
    // Windows can mark a protected DACL auto-inherited and materialize its inherited
    // ACEs as explicit. Preserve every other control bit and ordered ACE byte.
    const comparable = (acl: typeof original) => ({
      owner: acl.owner,
      protected: acl.protected,
      canonical: acl.canonical,
      flags: acl.flags,
      aces: acl.aces,
    });
    assert.deepEqual(comparable(restored), comparable(original));
    assert.equal(inspectWindowsPrivatePathSync(path, "file").private, true);
    assert.deepEqual(await readWindowsPrivateFile(path, 65_536), originalBytes);
    checkIdentity();
  };
  try {
    await execWindowsJob(
      join(process.env.SystemRoot!, "System32", "icacls.exe"),
      [path, "/grant", "*S-1-1-0:(R)", "/Q"],
      { timeout: 20_000 },
    );
    const exposed = await snapshot();
    assert.notEqual(exposed, original.sddl);
    assert.equal(inspectWindowsPrivatePathSync(path, "file").private, false);
    return { exposed, snapshot, restore };
  } catch (error) {
    if (error !== null && typeof error === "object" && Object.hasOwn(error, "cleanupFailure"))
      throw error;
    await restore();
    throw error;
  }
}
