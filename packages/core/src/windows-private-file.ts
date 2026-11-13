// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { runWindowsJob } from "./windows-job.js";
import { windowsPowerShellExecutable } from "./windows-process-tree.js";

const MAX_BYTES = 16_384;

// Security descriptors are inspected on the open handle, not on a second path
// lookup. CreateNew applies the protected DACL before any private bytes exist.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class OmnesisPrivateFile {
  [StructLayout(LayoutKind.Sequential,Pack=4)] struct Info {
    public uint attributes; public long creation,access,write;
    public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint mode,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
  static string User() { return WindowsIdentity.GetCurrent().User.Value; }
  static bool Trusted(string sid) { return sid==User() || sid=="S-1-5-18" || sid=="S-1-5-32-544"; }
  static void Validate(FileStream file) {
    Info info;
    if(!GetFileInformationByHandle(file.SafeFileHandle,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if((info.attributes & (0x10|0x400))!=0 || info.sizeHigh!=0 || info.sizeLow>16384)
      throw new InvalidDataException();
    FileSecurity security=file.GetAccessControl();
    if(!Trusted(security.GetOwner(typeof(SecurityIdentifier)).Value)) throw new UnauthorizedAccessException();
    RawSecurityDescriptor raw=new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(),0);
    if(raw.DiscretionaryAcl==null) throw new UnauthorizedAccessException();
    foreach(GenericAce ace in raw.DiscretionaryAcl) {
      QualifiedAce rule=ace as QualifiedAce;
      if(rule==null || (rule.AceQualifier!=AceQualifier.AccessAllowed && rule.AceQualifier!=AceQualifier.AccessDenied))
        throw new UnauthorizedAccessException();
      if(rule.AceQualifier==AceQualifier.AccessAllowed && !Trusted(rule.SecurityIdentifier.Value))
        throw new UnauthorizedAccessException();
    }
  }
  public static void Read(string path) {
    using(SafeFileHandle handle=CreateFile(path,0x80020000,1,IntPtr.Zero,3,0x200000,IntPtr.Zero)) {
      if(handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      using(FileStream file=new FileStream(handle,FileAccess.Read)) {
        Validate(file);
        byte[] bytes=new byte[16385]; int count=0,read;
        while(count<bytes.Length && (read=file.Read(bytes,count,bytes.Length-count))!=0) count+=read;
        if(count>16384) throw new InvalidDataException();
        Console.OpenStandardOutput().Write(bytes,0,count);
      }
    }
  }
  public static void Create(string path) {
    FileSecurity security=new FileSecurity();
    security.SetOwner(new SecurityIdentifier(User()));
    security.SetAccessRuleProtection(true,false);
    foreach(string sid in new string[]{User(),"S-1-5-18","S-1-5-32-544"})
      security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));
    using(FileStream file=new FileStream(path,FileMode.CreateNew,FileSystemRights.FullControl,FileShare.None,4096,FileOptions.None,security)) {
      Stream input=Console.OpenStandardInput(); byte[] bytes=new byte[16385]; int count=0,read;
      while(count<bytes.Length && (read=input.Read(bytes,count,bytes.Length-count))!=0) count+=read;
      if(count>16384) throw new InvalidDataException();
      Validate(file);
      file.Write(bytes,0,count); file.Flush(true);
    }
  }
}
'@
if ($env:OMNESIS_PRIVATE_FILE_ACTION -eq 'create') {
  [OmnesisPrivateFile]::Create($env:OMNESIS_PRIVATE_FILE_PATH)
} else {
  [OmnesisPrivateFile]::Read($env:OMNESIS_PRIVATE_FILE_PATH)
}
} catch {
  $cause = $_.Exception
  while ($cause.InnerException) { $cause = $cause.InnerException }
  $code = $cause.HResult -band 65535
  if ($cause -is [System.ComponentModel.Win32Exception]) { $code = $cause.NativeErrorCode }
  if ($code -eq 2 -or $code -eq 3) { [Console]::Error.Write('ENOENT') }
  elseif ($code -eq 80 -or $code -eq 183) { [Console]::Error.Write('EEXIST') }
  else { [Console]::Error.Write('EPRIVATE') }
  exit 1
}
`;

async function operate(
  path: string,
  action: "read" | "create",
  input?: Uint8Array,
): Promise<Buffer> {
  if (path.includes("\0")) throw new Error("Invalid private file path");
  if (input && input.byteLength > MAX_BYTES) throw new Error("Private file is too large");
  const result = await runWindowsJob(
    windowsPowerShellExecutable(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(SCRIPT, "utf16le").toString("base64"),
    ],
    {
      env: { ...process.env, OMNESIS_PRIVATE_FILE_PATH: path, OMNESIS_PRIVATE_FILE_ACTION: action },
      input,
      timeoutMs: 30_000,
    },
  );
  if (result.failure || result.exitCode !== 0) {
    const code =
      result.stderr === "ENOENT" ? "ENOENT" : result.stderr === "EEXIST" ? "EEXIST" : "EPRIVATE";
    throw Object.assign(
      new Error(
        "Private file must be a bounded private regular file with a trusted Windows owner and ACL",
      ),
      { code },
    );
  }
  if (result.stdout.byteLength > MAX_BYTES) throw new Error("Private file is too large");
  return Buffer.from(result.stdout);
}

/** Read a bounded regular file through the handle whose owner and DACL are verified. */
export function readWindowsPrivateFile(path: string): Promise<Buffer> {
  return operate(path, "read");
}

/** Create a new file with a private DACL atomically, before writing secret bytes. */
export async function createWindowsPrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  await operate(path, "create", bytes);
}
