// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { gzipSync } from "node:zlib";
import { runWindowsJob, runWindowsJobSync, type WindowsJobResult } from "./windows-job.js";
import { windowsPowerShellExecutable } from "./windows-powershell.js";

const MAX_BYTES = 16_384;

// Security descriptors are inspected on the open handle, not on a second path
// lookup. CreateNew applies the protected DACL before any private bytes exist.
const SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$WarningPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class OmnesisPrivateFile {
  [StructLayout(LayoutKind.Sequential,Pack=4)] struct Info {
    public uint attributes; public long creation,access,write;
    public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint mode,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int kind,IntPtr info,uint size);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle handle,int kind,uint sections,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(SafeFileHandle handle,int kind,uint sections,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr dacl,out bool defaulted);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  static string User() { return WindowsIdentity.GetCurrent().User.Value; }
  static bool Trusted(string sid) { return sid==User() || sid=="S-1-5-18" || sid=="S-1-5-32-544"; }
  static void Check(bool value) { if(!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void CheckCode(uint value) { if(value!=0) throw new Win32Exception((int)value); }
  static Info Information(SafeFileHandle handle,bool directory) {
    Info info; Check(GetFileInformationByHandle(handle,out info));
    if((info.attributes&0x400)!=0 || ((info.attributes&0x10)!=0)!=directory) throw new UnauthorizedAccessException();
    return info;
  }
  static SafeFileHandle Open(string path,bool directory,bool repair,uint share) {
    SafeFileHandle handle=CreateFile(path,0x20080U|(repair?0x40000U:0U),share,IntPtr.Zero,3,0x200000U|(directory?0x2000000U:0U),IntPtr.Zero);
    if(handle.IsInvalid) { int code=Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(code); }
    try { Information(handle,directory); return handle; } catch { handle.Dispose(); throw; }
  }
  static RawSecurityDescriptor Security(SafeFileHandle handle) {
    IntPtr owner,group,dacl,sacl,descriptor;
    CheckCode(GetSecurityInfo(handle,1,5,out owner,out group,out dacl,out sacl,out descriptor));
    try {
      uint length=GetSecurityDescriptorLength(descriptor);
      if(length==0 || length>1048576) throw new UnauthorizedAccessException();
      byte[] bytes=new byte[length]; Marshal.Copy(descriptor,bytes,0,(int)length);
      return new RawSecurityDescriptor(bytes,0);
    } finally { LocalFree(descriptor); }
  }
  static bool Private(RawSecurityDescriptor descriptor,bool parent) {
    if(descriptor.Owner==null || !Trusted(descriptor.Owner.Value) || descriptor.DiscretionaryAcl==null) return false;
    if(!parent && (descriptor.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0) return false;
    foreach(GenericAce ace in descriptor.DiscretionaryAcl) {
      QualifiedAce rule=ace as QualifiedAce;
      if(rule==null || (rule.AceQualifier!=AceQualifier.AccessAllowed && rule.AceQualifier!=AceQualifier.AccessDenied)) return false;
      if(rule.AceQualifier==AceQualifier.AccessAllowed && !Trusted(rule.SecurityIdentifier.Value)) {
        if(!parent || ((rule.AceFlags&AceFlags.InheritOnly)==0 && ((uint)rule.AccessMask&0x500D0156U)!=0)) return false;
      }
    }
    return true;
  }
  static void RequirePrivate(SafeFileHandle handle) { if(!Private(Security(handle),false)) throw new UnauthorizedAccessException(); }
  static FileSecurity FileAcl() {
    FileSecurity security=new FileSecurity(); security.SetOwner(new SecurityIdentifier(User())); security.SetAccessRuleProtection(true,false);
    foreach(string sid in new string[]{User(),"S-1-5-18","S-1-5-32-544"}) security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));
    return security;
  }
  static void Repair(SafeFileHandle handle,bool directory) {
    byte[] bytes;
    if(directory) {
      DirectorySecurity security=new DirectorySecurity(); security.SetAccessRuleProtection(true,false);
      foreach(string sid in new string[]{User(),"S-1-5-18","S-1-5-32-544"}) security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
      bytes=security.GetSecurityDescriptorBinaryForm();
    } else bytes=FileAcl().GetSecurityDescriptorBinaryForm();
    GCHandle pinned=GCHandle.Alloc(bytes,GCHandleType.Pinned);
    try {
      bool present,defaulted; IntPtr dacl;
      Check(GetSecurityDescriptorDacl(pinned.AddrOfPinnedObject(),out present,out dacl,out defaulted));
      if(!present || dacl==IntPtr.Zero) throw new UnauthorizedAccessException();
      CheckCode(SetSecurityInfo(handle,1,0x80000004U,IntPtr.Zero,IntPtr.Zero,dacl,IntPtr.Zero));
    } finally { pinned.Free(); }
    RequirePrivate(handle);
  }
  static string FullPath(string path) {
    string full=Path.GetFullPath(path),root=Path.GetPathRoot(full);
    if(full.Substring(root.Length).IndexOf(':')>=0) throw new UnauthorizedAccessException();
    return full;
  }
  static SafeFileHandle Parent(string path) {
    SafeFileHandle handle=Open(Path.GetDirectoryName(path),true,false,3);
    if(!Private(Security(handle),true)) { handle.Dispose(); throw new UnauthorizedAccessException(); }
    return handle;
  }
  static byte[] ReadExact(int count) {
    byte[] bytes=new byte[count]; int offset=0,read; Stream input=Console.OpenStandardInput();
    while(offset<count && (read=input.Read(bytes,offset,count-offset))!=0) offset+=read;
    if(offset!=count) throw new EndOfStreamException(); return bytes;
  }
  public static string Configuration() {
    uint count=BitConverter.ToUInt32(ReadExact(4),0);
    if(count==0 || count>2097152) throw new InvalidDataException();
    return new UTF8Encoding(false,true).GetString(ReadExact((int)count));
  }
  public static void Read(string path,int limit) {
    path=FullPath(path);
    using(SafeFileHandle handle=CreateFile(path,0x80020000,1,IntPtr.Zero,3,0x200000,IntPtr.Zero)) {
      if(handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      Info info=Information(handle,false); if(info.sizeHigh!=0 || info.sizeLow>limit) throw new InvalidDataException();
      RequirePrivate(handle);
      using(FileStream file=new FileStream(handle,FileAccess.Read)) {
        byte[] bytes=new byte[limit+1]; int count=0,read;
        while(count<bytes.Length && (read=file.Read(bytes,count,bytes.Length-count))!=0) count+=read;
        if(count>limit) throw new InvalidDataException(); Console.OpenStandardOutput().Write(bytes,0,count);
      }
    }
  }
  static void ReadOnly(SafeFileHandle file,bool value) {
    IntPtr info=Marshal.AllocHGlobal(40);
    try {
      for(int i=0;i<40;i++) Marshal.WriteByte(info,i,0);
      uint attributes=Information(file,false).attributes;
      Marshal.WriteInt32(info,32,(int)(value?attributes|1:attributes&~1U));
      Check(SetFileInformationByHandle(file,0,info,40));
    } finally { Marshal.FreeHGlobal(info); }
  }
  static void Rename(SafeFileHandle file,SafeFileHandle parent,string target) {
    // SMB requires an absolute name and a null RootDirectory; the validated
    // parent denies untrusted writes and stays pinned without delete sharing.
    bool network=target.StartsWith(@"\\");
    byte[] name=Encoding.Unicode.GetBytes(network?target:Path.GetFileName(target));
    int rootOffset=IntPtr.Size,lengthOffset=IntPtr.Size*2,nameOffset=lengthOffset+4;
    IntPtr info=Marshal.AllocHGlobal(nameOffset+name.Length);
    try {
      for(int i=0;i<nameOffset;i++) Marshal.WriteByte(info,i,0);
      Marshal.WriteInt32(info,0,0x43); Marshal.WriteIntPtr(info,rootOffset,network?IntPtr.Zero:parent.DangerousGetHandle());
      Marshal.WriteInt32(info,lengthOffset,name.Length); Marshal.Copy(name,0,IntPtr.Add(info,nameOffset),name.Length);
      int kind=22;
      for(int attempt=0;;attempt++) {
        if(SetFileInformationByHandle(file,kind,info,(uint)(nameOffset+name.Length))) break;
        int error=Marshal.GetLastWin32Error();
        if(kind==22 && (error==50 || error==87)) { kind=3; Marshal.WriteInt32(info,0,1); continue; }
        if((error!=5 && error!=32 && error!=33) || attempt>=40) throw new Win32Exception(error);
        System.Threading.Thread.Sleep(25);
      }
    } finally { Marshal.FreeHGlobal(info); }
  }
  static void Discard(SafeFileHandle file) {
    try { ReadOnly(file,false); } catch { }
    IntPtr info=Marshal.AllocHGlobal(4);
    try { Marshal.WriteInt32(info,1); SetFileInformationByHandle(file,4,info,4); } finally { Marshal.FreeHGlobal(info); }
  }
  public static void Write(string path,long length,bool atomic,bool readOnly) {
    path=FullPath(path); if(length<0) throw new InvalidDataException();
    using(SafeFileHandle parent=Parent(path)) {
      string scratch=atomic?path+".omnesis-"+System.Diagnostics.Process.GetCurrentProcess().Id+"-"+Guid.NewGuid().ToString("N")+".tmp":path;
      bool published=false;
      using(FileStream file=new FileStream(scratch,FileMode.CreateNew,FileSystemRights.FullControl,FileShare.Read|FileShare.Delete,65536,FileOptions.None,FileAcl())) {
        try {
          Information(file.SafeFileHandle,false); RequirePrivate(file.SafeFileHandle);
          Stream input=Console.OpenStandardInput(); byte[] bytes=new byte[65536]; long remaining=length;
          while(remaining>0) {
            int read=input.Read(bytes,0,(int)Math.Min(bytes.Length,remaining)); if(read==0) throw new EndOfStreamException();
            file.Write(bytes,0,read); remaining-=read;
          }
          if(input.ReadByte()!=-1) throw new InvalidDataException();
          file.Flush(true); if(readOnly) ReadOnly(file.SafeFileHandle,true); if(atomic) Rename(file.SafeFileHandle,parent,path); published=true;
        } finally { if(!published) Discard(file.SafeFileHandle); }
      }
    }
  }
  public static string Inspect(string path,bool directory,bool repair) {
    path=FullPath(path);
    using(SafeFileHandle parent=Parent(path))
    using(SafeFileHandle handle=Open(path,directory,repair,7)) {
      RawSecurityDescriptor descriptor=Security(handle);
      if(descriptor.Owner==null || !Trusted(descriptor.Owner.Value)) throw new UnauthorizedAccessException();
      if(Private(descriptor,false)) return "private";
      if(!repair) return "unsafe";
      Repair(handle,directory); return "fixed";
    }
  }
}
'@
$config=[OmnesisPrivateFile]::Configuration() | ConvertFrom-Json
if ($config.action -eq 'create' -or $config.action -eq 'atomic') {
  [OmnesisPrivateFile]::Write([string]$config.path,[long]$config.length,($config.action -eq 'atomic'),[bool]$config.readOnly)
} elseif ($config.action -eq 'inspect') {
  $results=@(foreach ($entry in $config.paths) {
    try {
      $state=[OmnesisPrivateFile]::Inspect([string]$entry.path,($entry.kind -eq 'directory'),[bool]$config.repair)
      @{private=($state -ne 'unsafe');fixed=($state -eq 'fixed')}
    } catch { @{private=$false;fixed=$false;error='EPRIVATE'} }
  })
  [Console]::Out.Write((ConvertTo-Json -InputObject $results -Compress))
} else { [OmnesisPrivateFile]::Read([string]$config.path,[int]$config.limit) }
} catch {
  $cause=$_.Exception
  while ($cause.InnerException) { $cause=$cause.InnerException }
  $code=$cause.HResult -band 65535
  if ($cause -is [System.ComponentModel.Win32Exception]) { $code=$cause.NativeErrorCode }
  if ($code -eq 2 -or $code -eq 3) { [Console]::Error.Write('ENOENT') }
  elseif ($code -eq 80 -or $code -eq 183) { [Console]::Error.Write('EEXIST') }
  else { [Console]::Error.Write('EPRIVATE') }
  exit 1
}
`;

export interface WindowsPrivatePath {
  path: string;
  kind: "file" | "directory";
}
export interface WindowsPrivatePathStatus {
  private: boolean;
  fixed: boolean;
  error?: "EPRIVATE";
}
type Operation =
  | { action: "create" | "atomic"; path: string; length: number; readOnly: boolean }
  | { action: "read"; path: string; limit: number }
  | { action: "inspect"; paths: readonly WindowsPrivatePath[]; repair: boolean };

let program: string | undefined;
function encodedProgram(): string {
  if (program !== undefined) return program;
  // Only this constant public program is decompressed in memory. The reader
  // never touches stdin, whose metadata and secret bytes use exact native reads.
  const source = gzipSync(Buffer.from(SCRIPT, "utf8")).toString("base64");
  const bootstrap = `$memory=[IO.MemoryStream]::new([Convert]::FromBase64String('${source}'),$false);$gzip=[IO.Compression.GZipStream]::new($memory,[IO.Compression.CompressionMode]::Decompress);$reader=[IO.StreamReader]::new($gzip,[Text.Encoding]::UTF8);try { & ([scriptblock]::Create($reader.ReadToEnd())) } finally { $reader.Dispose();$memory.Dispose() }`;
  program = Buffer.from(bootstrap, "utf16le").toString("base64");
  return program;
}

function invocation(
  operation: Operation,
  input?: Uint8Array,
): { command: string; args: string[]; input: Buffer } {
  const paths =
    operation.action === "inspect" ? operation.paths.map((entry) => entry.path) : [operation.path];
  if (paths.length > 5000 || paths.some((path) => path.includes("\0")))
    throw new Error("Invalid private file path");
  const metadata = Buffer.from(JSON.stringify(operation), "utf8");
  if (metadata.length > 2097152) throw new Error("Private file operation is too large");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(metadata.length);
  const command = windowsPowerShellExecutable();
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedProgram()];
  // The native Job launcher quotes each argument, including the executable.
  if (command.length + 3 + args.reduce((size, arg) => size + arg.length + 3, 0) > 32767) {
    throw new Error("Windows private helper command line is too large");
  }
  return { command, args, input: Buffer.concat([length, metadata, Buffer.from(input ?? [])]) };
}
function resultBytes(result: WindowsJobResult): Buffer {
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
  return Buffer.from(result.stdout);
}
async function operate(operation: Operation, input?: Uint8Array): Promise<Buffer> {
  const run = invocation(operation, input);
  return resultBytes(
    await runWindowsJob(run.command, run.args, { input: run.input, timeoutMs: 30_000 }),
  );
}
function operateSync(operation: Operation, input?: Uint8Array): Buffer {
  const run = invocation(operation, input);
  return resultBytes(
    runWindowsJobSync(run.command, run.args, { input: run.input, timeoutMs: 30_000 }),
  );
}
/** Read a bounded regular file through the handle whose owner and DACL are verified. */
export function readWindowsPrivateFile(path: string, limit = MAX_BYTES): Promise<Buffer> {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 16 * 1024 * 1024)
    throw new Error("Invalid private file read bound");
  return operate({ action: "read", path, limit });
}
/** Create a new file with a private DACL atomically, before writing secret bytes. */
export async function createWindowsPrivateFile(
  path: string,
  bytes: Uint8Array,
  opts: { readOnly?: boolean } = {},
): Promise<void> {
  await operate(
    { action: "create", path, length: bytes.byteLength, readOnly: opts.readOnly === true },
    bytes,
  );
}
export function createWindowsPrivateFileSync(
  path: string,
  bytes: Uint8Array,
  opts: { readOnly?: boolean } = {},
): void {
  operateSync(
    { action: "create", path, length: bytes.byteLength, readOnly: opts.readOnly === true },
    bytes,
  );
}
/** Publish the flushed private file through its held handle, under a pinned safe parent. */
export async function writeWindowsPrivateFileAtomic(
  path: string,
  bytes: Uint8Array,
  opts: { readOnly?: boolean } = {},
): Promise<void> {
  await operate(
    { action: "atomic", path, length: bytes.byteLength, readOnly: opts.readOnly === true },
    bytes,
  );
}
export function writeWindowsPrivateFileAtomicSync(
  path: string,
  bytes: Uint8Array,
  opts: { readOnly?: boolean } = {},
): void {
  operateSync(
    { action: "atomic", path, length: bytes.byteLength, readOnly: opts.readOnly === true },
    bytes,
  );
}
function statuses(bytes: Buffer, count: number): WindowsPrivatePathStatus[] {
  const values: unknown = JSON.parse(bytes.toString("utf8"));
  if (
    !Array.isArray(values) ||
    values.length !== count ||
    values.some(
      (value: unknown) =>
        typeof value !== "object" ||
        value === null ||
        !("private" in value) ||
        typeof value.private !== "boolean" ||
        !("fixed" in value) ||
        typeof value.fixed !== "boolean" ||
        ("error" in value && value.error !== "EPRIVATE"),
    )
  ) {
    throw new Error("Invalid private file inspection result");
  }
  return values as WindowsPrivatePathStatus[];
}
export async function inspectWindowsPrivatePaths(
  paths: readonly WindowsPrivatePath[],
  opts: { repair?: boolean } = {},
): Promise<WindowsPrivatePathStatus[]> {
  if (paths.length === 0) return [];
  return statuses(
    await operate({ action: "inspect", paths, repair: opts.repair === true }),
    paths.length,
  );
}
export function inspectWindowsPrivatePathSync(
  path: string,
  kind: WindowsPrivatePath["kind"],
): WindowsPrivatePathStatus {
  return statuses(
    operateSync({ action: "inspect", paths: [{ path, kind }], repair: false }),
    1,
  )[0]!;
}
export function secureWindowsPrivatePathSync(path: string, kind: WindowsPrivatePath["kind"]): void {
  const result = statuses(
    operateSync({ action: "inspect", paths: [{ path, kind }], repair: true }),
    1,
  )[0]!;
  if (!result.private)
    throw new Error("Private path requires a trusted Windows owner and safe ACL");
}
