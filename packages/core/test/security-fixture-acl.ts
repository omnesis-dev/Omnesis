// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { execWindowsJob } from "../src/windows-job-exec.js";
import { windowsPowerShellExecutable } from "../src/windows-process-tree.js";
import { inspectWindowsPrivatePathSync } from "../src/windows-private-file.js";
import { ownedProcessCleanupReceipt } from "../src/owned-process-cleanup.js";

const uncertainPaths = new Set<string>();
function observeFailure(path: string, error: unknown): void {
  if (ownedProcessCleanupReceipt(error) !== undefined) uncertainPaths.add(resolve(path));
}

/** Record synchronous canonical fixture-helper failures before test errors are serialized. */
export function ownedWindowsFixtureOperation<T>(path: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    observeFailure(path, error);
    throw error;
  }
}

/** Keep only fixture roots that can overlap an explicitly unjoined helper. */
export function windowsFixtureCleanupMustWait(root: string): boolean {
  const contains = (parent: string, child: string) => {
    const suffix = relative(parent, child);
    return (
      suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
    );
  };
  return [...uncertainPaths].some(
    (path) => contains(resolve(root), path) || contains(path, resolve(root)),
  );
}

function assertPrivate(path: string, kind: "directory" | "file"): void {
  ownedWindowsFixtureOperation(path, () =>
    assert.equal(inspectWindowsPrivatePathSync(path, kind).private, true),
  );
}

async function run(path: string, script: string, sddl = ""): Promise<string> {
  try {
    const result = await execWindowsJob(
      windowsPowerShellExecutable(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop';" + script,
      ],
      {
        timeout: 20_000,
        env: {
          ...process.env,
          OMNESIS_DOCTOR_FIXTURE_PATH: path,
          OMNESIS_DOCTOR_FIXTURE_SDDL: sddl,
        },
      },
    );
    return String(result.stdout).trim();
  } catch (error) {
    observeFailure(path, error);
    throw error;
  }
}

/** Capture owner and ordered DACL bytes of one unique, test-owned path. */
export async function snapshotWindowsFixtureAcl(path: string) {
  const output = await run(
    path,
    String.raw`
$path=$env:OMNESIS_DOCTOR_FIXTURE_PATH
$sections=[Security.AccessControl.AccessControlSections]'Owner,Access'
$directory=([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::Directory) -ne 0
$acl=if($directory){[IO.Directory]::GetAccessControl($path,$sections)}else{[IO.File]::GetAccessControl($path,$sections)}
$sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Access')
$descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($sddl)
$protected=$acl.AreAccessRulesProtected
$flags=[int]$descriptor.ControlFlags
if ($protected) { $flags=$flags -band (-bnot [int]([Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited)) }
$aces=@(foreach ($ace in $descriptor.DiscretionaryAcl) {
  $bytes=[byte[]]::new($ace.BinaryLength)
  $ace.GetBinaryForm($bytes,0)
  if ($protected) { $bytes[1]=[byte]($bytes[1] -band (-bnot [int]([Security.AccessControl.AceFlags]::Inherited))) }
  [Convert]::ToBase64String($bytes)
})
[Console]::Write((@{sddl=$sddl;owner=$descriptor.Owner.Value;protected=$protected;canonical=$acl.AreAccessRulesCanonical;flags=$flags;aces=$aces}|ConvertTo-Json -Compress))
`,
  );
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
}

/** Deny both listing and known-child attributes, then restore captured owned ACLs. */
export async function denyOwnedDirectoryReads(directory: string, child: string) {
  const paths = [directory, child];
  const identities = paths.map((path) => lstatSync(path, { bigint: true }));
  assert.ok(identities[0]!.isDirectory() && identities[1]!.isFile());
  assert.ok(identities.every((identity) => !identity.isSymbolicLink()));
  assert.equal(identities[1]!.nlink, 1n);
  for (const [index, path] of paths.entries())
    assertPrivate(path, index === 0 ? "directory" : "file");
  const bytes = readFileSync(child);
  const originals = await Promise.all(paths.map(snapshotWindowsFixtureAcl));
  assert.ok(originals.every((acl) => acl.protected && acl.canonical));
  const comparable = ({ sddl: _sddl, ...acl }: (typeof originals)[number]) => acl;
  const restore = async () => {
    for (const [index, path] of paths.entries()) {
      const kind = index === 0 ? "Directory" : "File";
      await run(
        path,
        String.raw`
$acl=[IO.${kind}]::GetAccessControl($env:OMNESIS_DOCTOR_FIXTURE_PATH)
$acl.SetSecurityDescriptorSddlForm($env:OMNESIS_DOCTOR_FIXTURE_SDDL,[Security.AccessControl.AccessControlSections]::Access)
[IO.${kind}]::SetAccessControl($env:OMNESIS_DOCTOR_FIXTURE_PATH,$acl)
`,
        originals[index]!.sddl,
      );
    }
    for (const [index, path] of paths.entries()) {
      const identity = lstatSync(path, { bigint: true });
      assert.deepEqual(
        [identity.dev, identity.ino, identity.birthtimeNs],
        [identities[index]!.dev, identities[index]!.ino, identities[index]!.birthtimeNs],
      );
      // Protected DACL restoration may normalize only AI and inherited ACE flags.
      assert.deepEqual(
        comparable(await snapshotWindowsFixtureAcl(path)),
        comparable(originals[index]!),
      );
      assertPrivate(path, index === 0 ? "directory" : "file");
    }
    assert.deepEqual(readFileSync(child), bytes);
  };
  try {
    await run(
      directory,
      String.raw`
$acl=[IO.Directory]::GetAccessControl($env:OMNESIS_DOCTOR_FIXTURE_PATH)
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$rights=[Security.AccessControl.FileSystemRights]::ReadData -bor [Security.AccessControl.FileSystemRights]::ReadAttributes
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,$rights,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Deny))
[IO.Directory]::SetAccessControl($env:OMNESIS_DOCTOR_FIXTURE_PATH,$acl)
`,
    );
    // The child is protected, so apply the identical deny explicitly as well.
    await run(
      child,
      String.raw`
$acl=[IO.File]::GetAccessControl($env:OMNESIS_DOCTOR_FIXTURE_PATH)
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$rights=[Security.AccessControl.FileSystemRights]::ReadData -bor [Security.AccessControl.FileSystemRights]::ReadAttributes
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,$rights,[Security.AccessControl.AccessControlType]::Deny))
[IO.File]::SetAccessControl($env:OMNESIS_DOCTOR_FIXTURE_PATH,$acl)
`,
    );
    return restore;
  } catch (error) {
    if (ownedProcessCleanupReceipt(error) === undefined) await restore();
    throw error;
  }
}
