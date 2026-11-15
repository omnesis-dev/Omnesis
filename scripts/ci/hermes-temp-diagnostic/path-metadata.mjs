// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { statSync } from "node:fs";
const [path, expectedParent] = process.argv.slice(2);
const encoded = Buffer.from(path, "utf16le").toString("base64");
const script = `$ErrorActionPreference='Stop';$p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'));$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=([IO.DirectoryInfo]::new($p)).GetAccessControl();$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]);$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);$broad=@('S-1-1-0','S-1-5-11','S-1-5-32-545');$allow=0;$deny=0;$inherited=0;foreach($r in $rules){if($r.IsInherited){$inherited++};if($r.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $broad -contains $r.IdentityReference.Value -and ([int64]$r.FileSystemRights -band 1) -ne 0){$allow++};if($r.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny -and $r.IdentityReference -eq $sid -and ([int64]$r.FileSystemRights -band 1) -ne 0){$deny++}};[ordered]@{ownerIsCurrent=($owner -eq $sid);ownerIsSystem=($owner.Value -eq 'S-1-5-18');ownerIsAdministrators=($owner.Value -eq 'S-1-5-32-544');protected=$acl.AreAccessRulesProtected;inheritedAceCount=$inherited;explicitAceCount=($rules.Count-$inherited);broadReadAllowCount=$allow;currentReadDenyCount=$deny}|ConvertTo-Json -Compress`;
const systemRoot = Object.entries(process.env).find(
  ([key]) => key.toUpperCase() === "SYSTEMROOT",
)?.[1];
if (!systemRoot) throw Error("Missing system root");
const metadata = spawnSync(
  join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
  [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ],
  { timeout: 30000, encoding: "utf8" },
);
const row = {
  metadataReturned: metadata.status === 0 && !metadata.error && !metadata.signal,
};
if (metadata.error || metadata.signal) {
  console.log(
    JSON.stringify({
      metadataReturned: false,
      metadataProcessFailed: true,
      cleanupUnconfirmed: true,
    }),
  );
  process.exit(1);
}
if (expectedParent) {
  const parentStat = statSync(dirname(path), { bigint: true }),
    expectedStat = statSync(expectedParent, { bigint: true });
  row.sameParentIdentity =
    parentStat.dev === expectedStat.dev && parentStat.ino === expectedStat.ino;
}
if (row.metadataReturned) {
  const value = JSON.parse(metadata.stdout);
  for (const key of ["ownerIsCurrent", "ownerIsSystem", "ownerIsAdministrators", "protected"]) {
    if (typeof value[key] !== "boolean") throw Error("Invalid boolean metadata");
    row[key] = value[key];
  }
  for (const key of [
    "inheritedAceCount",
    "explicitAceCount",
    "broadReadAllowCount",
    "currentReadDenyCount",
  ]) {
    if (!Number.isInteger(value[key]) || value[key] < 0) throw Error("Invalid count metadata");
    row[key] = value[key];
  }
}
try {
  const { privateWindowsFiles } = await import("./runtime/windows-files.js");
  const result = privateWindowsFiles().inspectWindowsPrivatePathSync(path, "directory");
  row.nativeInspectReturned = true;
  row.private = result.private === true;
  row.fixed = result.fixed === true;
} catch (error) {
  row.nativeInspectReturned = false;
  row.cleanupUnconfirmed =
    error !== null &&
    (typeof error === "object" || typeof error === "function") &&
    Object.hasOwn(error, "cleanupFailure");
  if (["EPRIVATE", "EACCES", "ENOENT"].includes(error?.code)) row.code = error.code;
  if (Number.isInteger(error?.nativeCode)) row.nativeCode = error.nativeCode;
}
console.log(JSON.stringify(row));
if (metadata.error || metadata.signal) process.exitCode = 1;
