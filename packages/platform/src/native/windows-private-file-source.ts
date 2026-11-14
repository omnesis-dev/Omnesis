// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { WINDOWS_DIRECTORY_POLICY_NATIVE_SOURCE } from "./windows-directory-policy-source.js";
import { WINDOWS_FILE_REPAIR_NATIVE_SOURCE } from "./windows-file-repair-source.js";

export const WINDOWS_PRIVATE_FILE_NATIVE_SOURCE =
  String.raw`using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static partial class OmnesisPrivateFile {
  public static string Stage="bootstrap";
  [StructLayout(LayoutKind.Sequential,Pack=4)] struct Info {
    public uint attributes; public long creation,access,write;
    public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow;
  }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode,Pack=4)] struct FindData {
    public uint attributes; public long creation,access,write;
    public uint high,low,reserved0,reserved1;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string name;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=14)] public string alternate;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindFirstFile(string path,out FindData data);
  [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint mode,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int kind,IntPtr info,uint size);
  [StructLayout(LayoutKind.Sequential)] struct RenameIoStatus { public IntPtr status; public UIntPtr information; }
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle file,out RenameIoStatus io,IntPtr info,uint size,int kind);
  [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle handle,int kind,uint sections,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("ntdll.dll")] static extern int NtSetSecurityObject(SafeFileHandle handle,uint sections,IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
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
  // Cache bootstrap also uses this low-level metadata opener while its own
  // CachePins policy is held. Private path operations use relative opens below.
  static SafeFileHandle Open(string path,bool directory,bool repair,uint share) {
    uint access=0x20080U|(repair?0x40000U:0U);
    if(directory && (share&4U)==0) access|=0x20U;
    SafeFileHandle handle=CreateFile(path,access,share,IntPtr.Zero,3,0x200000U|(directory?0x2000000U:0U),IntPtr.Zero);
    if(handle.IsInvalid) {int code=Marshal.GetLastWin32Error();handle.Dispose();throw new Win32Exception(code);}
    try {Information(handle,directory);return handle;} catch {handle.Dispose();throw;}
  }
  static RawSecurityDescriptor Security(SafeFileHandle handle,int kind=1) {
    IntPtr owner,group,dacl,sacl,descriptor;
    CheckCode(GetSecurityInfo(handle,kind,5,out owner,out group,out dacl,out sacl,out descriptor));
    try {
      uint length=GetSecurityDescriptorLength(descriptor);
      if(length==0 || length>1048576) throw new UnauthorizedAccessException();
      byte[] bytes=new byte[length]; Marshal.Copy(descriptor,bytes,0,(int)length);
      return new RawSecurityDescriptor(bytes,0);
    } finally { LocalFree(descriptor); }
  }
  static bool Private(RawSecurityDescriptor descriptor,bool parent) {
    if(descriptor.Owner==null || !Trusted(descriptor.Owner.Value) || descriptor.DiscretionaryAcl==null) return false;
    foreach(GenericAce ace in descriptor.DiscretionaryAcl) {
      QualifiedAce rule=ace as QualifiedAce;
      if(rule==null || (rule.AceQualifier!=AceQualifier.AccessAllowed && rule.AceQualifier!=AceQualifier.AccessDenied)) return false;
      if(rule.AceQualifier==AceQualifier.AccessAllowed && !Trusted(rule.SecurityIdentifier.Value)) {
        if(!parent || ((rule.AceFlags&AceFlags.InheritOnly)==0 && ((uint)rule.AccessMask&0x500D0156U)!=0)) return false;
      }
    }
    return true;
  }
  static void RequirePrivate(SafeFileHandle handle,bool protection=false) {
    RawSecurityDescriptor descriptor=Security(handle);
    if(!Private(descriptor,false) || (protection && (descriptor.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0)) throw new UnauthorizedAccessException();
  }
  static FileSecurity FileAcl() {
    FileSecurity security=new FileSecurity(); security.SetOwner(new SecurityIdentifier(User())); security.SetAccessRuleProtection(true,false);
    foreach(string sid in new string[]{User(),"S-1-5-18","S-1-5-32-544"}) security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));
    return security;
  }
  static DirectorySecurity DirectoryAcl() {
    DirectorySecurity security=new DirectorySecurity();security.SetOwner(new SecurityIdentifier(User()));security.SetAccessRuleProtection(true,false);
    foreach(string sid in new string[]{User(),"S-1-5-18","S-1-5-32-544"}) security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
    return security;
  }
  static void RepairDirectory(SafeFileHandle handle) {
    Information(handle,true);
    byte[] bytes=DirectoryAcl().GetSecurityDescriptorBinaryForm();
    GCHandle pinned=GCHandle.Alloc(bytes,GCHandleType.Pinned);
    try {
      // Change only this held directory; inherited OI/CI grants protect future
      // children without propagating a repair into unrelated existing files.
      int status=NtSetSecurityObject(handle,0x80000004U,pinned.AddrOfPinnedObject());
      if(status<0) throw new Win32Exception((int)RtlNtStatusToDosError(status));
    } finally { pinned.Free(); }
    RequirePrivate(handle,true);
  }
  static string FullPath(string path) {
    string full=Path.GetFullPath(path),root=Path.GetPathRoot(full);
    if(full.Substring(root.Length).IndexOf(':')>=0) throw new UnauthorizedAccessException();
    return full;
  }
  [StructLayout(LayoutKind.Sequential)] struct RelativeName {
    public ushort length,maximum; public IntPtr buffer;
  }
  [StructLayout(LayoutKind.Sequential)] struct RelativeAttributes {
    public int length; public IntPtr root,name; public uint attributes;
    public IntPtr security,quality;
  }
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr handle,uint access,ref RelativeAttributes attributes,out RenameIoStatus io,IntPtr allocation,uint fileAttributes,uint share,uint disposition,uint options,IntPtr ea,uint eaLength);
  static SafeFileHandle RelativeOpen(SafeFileHandle parent,string name,bool directory,uint access,uint sharing,uint disposition=1U,byte[] security=null,uint extraOptions=0U) {
    if(String.IsNullOrEmpty(name) || name=="." || name==".." || name.IndexOfAny(new char[]{'\\','/',':','\0'})>=0) throw new InvalidDataException();
    IntPtr text=Marshal.StringToHGlobalUni(name),unicode=IntPtr.Zero;
    GCHandle descriptor=default(GCHandle);
    try {
      RelativeName value=new RelativeName();value.length=checked((ushort)(name.Length*2));value.maximum=value.length;value.buffer=text;
      unicode=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(RelativeName)));Marshal.StructureToPtr(value,unicode,false);
      RelativeAttributes attributes=new RelativeAttributes();attributes.length=Marshal.SizeOf(typeof(RelativeAttributes));attributes.root=parent.DangerousGetHandle();attributes.name=unicode;attributes.attributes=0x40;
      if(security!=null) {descriptor=GCHandle.Alloc(security,GCHandleType.Pinned);attributes.security=descriptor.AddrOfPinnedObject();}
      RenameIoStatus io;IntPtr raw;
      // Each lookup is one literal component below its retained parent.
      // No FILE_OPEN_FOR_BACKUP_INTENT: data access still obeys the source ACL.
      int status=NtCreateFile(out raw,access,ref attributes,out io,IntPtr.Zero,0,sharing,disposition,0x200020U|(directory?1U:0x40U)|extraOptions,IntPtr.Zero,0);
      SafeFileHandle handle=new SafeFileHandle(raw,true);
      try {
        if(status<0) throw new Win32Exception((int)RtlNtStatusToDosError(status));
        if(handle.IsInvalid) throw new InvalidDataException();
        Information(handle,directory);return handle;
      } catch {handle.Dispose();throw;}
    } finally {if(descriptor.IsAllocated) descriptor.Free();if(unicode!=IntPtr.Zero) Marshal.FreeHGlobal(unicode);Marshal.FreeHGlobal(text);}
  }
  sealed class PinnedParent : IDisposable {
    readonly List<SafeFileHandle> handles=new List<SafeFileHandle>();
    public readonly string Leaf;
    public SafeFileHandle Handle { get { return handles[handles.Count-1]; } }
    public PinnedParent(string path,bool security) {
      path=FullPath(path);if(path.Length>32767) throw new InvalidDataException();
      string root=Path.GetPathRoot(path);
      string[] components=path.Substring(root.Length).Split(new char[]{'\\','/'},StringSplitOptions.RemoveEmptyEntries);
      if(components.Length==0) throw new InvalidDataException();
      Leaf=components[components.Length-1];
      try {
        // TRAVERSE is essential: metadata-only opens do not enforce deny-delete
        // sharing. Only the immediate private parent additionally needs READ_CONTROL.
        uint rootAccess=0x1000A0U|((security && components.Length==1)?0x20000U:0U);
        SafeFileHandle volume=CreateFile(root,rootAccess,3,IntPtr.Zero,3,0x2200000,IntPtr.Zero);
        if(volume.IsInvalid) {int error=Marshal.GetLastWin32Error();volume.Dispose();throw new Win32Exception(error);}
        handles.Add(volume);Information(volume,true);
        for(int index=0;index<components.Length-1;index++) {
          uint access=0x1000A0U|((security && index==components.Length-2)?0x20000U:0U);
          handles.Add(RelativeOpen(Handle,components[index],true,access,3U));
        }
      } catch {Dispose();throw;}
    }
    public void Dispose() {for(int index=handles.Count-1;index>=0;index--) handles[index].Dispose();handles.Clear();}
  }
  static PinnedParent Parent(string path) {
    PinnedParent parent=new PinnedParent(path,true);
    try {if(!Private(Security(parent.Handle),true)) throw new UnauthorizedAccessException();return parent;}
    catch {parent.Dispose();throw;}
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
  static string StoredName(string path) {
    FindData data; IntPtr find=FindFirstFile(path,out data);
    if(find==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try { return data.name; } finally { FindClose(find); }
  }
  static void Names(string path,string exact,string exactParent) {
    if(exact.Length>0 && !String.Equals(StoredName(path),exact,StringComparison.Ordinal)) throw new Win32Exception(2);
    if(exactParent.Length>0 && !String.Equals(StoredName(Path.GetDirectoryName(path)),exactParent,StringComparison.Ordinal)) throw new Win32Exception(2);
  }
  public static void DeleteExact(string path,string exact,string exactParent) {
    Stage="resolve";path=FullPath(path);
    Stage="parent";
    using(PinnedParent parent=Parent(path))
    using(SafeFileHandle handle=RelativeOpen(parent.Handle,parent.Leaf,false,0x130181U,0U)) {
      Stage="validate";Information(handle,false); RequirePrivate(handle); Stage="name";Names(path,exact,exactParent);
      DeleteEntry(handle);
    }
  }
  public static void Read(string path,long limit,string exact,string exactParent) {
    Stage="resolve";path=FullPath(path);Stage="open";
    Stage="parent";using(PinnedParent parent=new PinnedParent(path,true)) {
      // A missing leaf is still absent even below a broadly writable checkout.
      // Existing files must pass the pinned parent's policy before any bytes.
      Stage="open";using(SafeFileHandle handle=RelativeOpen(parent.Handle,parent.Leaf,false,0x80120000U,1U)) {
      Stage="parent";if(!Private(Security(parent.Handle),true)) throw new UnauthorizedAccessException();
      Stage="validate";Info info=Information(handle,false);
      if(info.sizeHigh>Int32.MaxValue) throw new InvalidDataException();
      long length=((long)info.sizeHigh<<32)|info.sizeLow;
      if(limit>=0 && length>limit) throw new InvalidDataException();
      RequirePrivate(handle); Stage="name";Names(path,exact,exactParent);
      Stage="read";using(FileStream file=new FileStream(handle,FileAccess.Read)) {
        byte[] bytes=new byte[65536]; long remaining=length;
        Stream output=Console.OpenStandardOutput();
        while(remaining>0) {
          int read=file.Read(bytes,0,(int)Math.Min(bytes.Length,remaining));
          if(read==0) throw new EndOfStreamException();
          output.Write(bytes,0,read); remaining-=read;
        }
        if(file.ReadByte()!=-1) throw new InvalidDataException();
      }
      }
    }
  }
  static void ReadOnly(SafeFileHandle file) {
    Info current=Information(file,false);
    uint attributes=current.attributes|1U;
    if(attributes==current.attributes) return;
    if(current.links!=1) throw new UnauthorizedAccessException();
    IntPtr info=Marshal.AllocHGlobal(40);
    try {
      for(int i=0;i<40;i++) Marshal.WriteByte(info,i,0);
      Marshal.WriteInt32(info,32,(int)attributes);
      Check(SetFileInformationByHandle(file,0,info,40));
    } finally { Marshal.FreeHGlobal(info); }
  }
  static void Rename(SafeFileHandle file,SafeFileHandle parent,string target,bool replaceExisting,bool replacePinnedSource=false) {
    // SMB requires an absolute name and a null RootDirectory; the validated
    // parent denies untrusted writes and stays pinned without delete sharing.
    bool extendedNetwork=target.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase);
    bool network=extendedNetwork || (target.StartsWith(@"\\") && !target.StartsWith(@"\\?\"));
    string absolute=extendedNetwork?@"\??\"+target.Substring(4):@"\??\UNC\"+target.Substring(2);
    byte[] name=Encoding.Unicode.GetBytes(network?absolute:Path.GetFileName(target));
    int rootOffset=IntPtr.Size,lengthOffset=IntPtr.Size*2,nameOffset=lengthOffset+4;
    int infoSize=(IntPtr.Size==8?24:16)+name.Length;
    IntPtr info=Marshal.AllocHGlobal(infoSize);
    try {
      for(int i=0;i<infoSize;i++) Marshal.WriteByte(info,i,0);
      // Ordinary writers honor held source/read pins. Only copy-on-repair
      // replaces its own exclusively held source through POSIX semantics.
      Marshal.WriteInt32(info,0,(replaceExisting?0x41:0)|(replacePinnedSource?2:0)); Marshal.WriteIntPtr(info,rootOffset,network?IntPtr.Zero:parent.DangerousGetHandle());
      Marshal.WriteInt32(info,lengthOffset,name.Length); Marshal.Copy(name,0,IntPtr.Add(info,nameOffset),name.Length);
      // The Win32 wrapper rejects this valid relative RootDirectory form.
      // Native rename preserves the pinned parent instead of resolving a path
      // again. FileStream opened this handle synchronously (FileOptions.None).
      int kind=65;
      for(int attempt=0;;attempt++) {
        RenameIoStatus io;
        int status=NtSetInformationFile(file,out io,info,(uint)infoSize,kind);
        if(status>=0) break;
        int error=(int)RtlNtStatusToDosError(status);
        if(kind==65 && (error==50 || error==87)) { kind=10; Marshal.WriteInt32(info,0,replaceExisting?1:0); continue; }
        if((error!=5 && error!=32 && error!=33) || attempt>=40) throw new Win32Exception(error);
        System.Threading.Thread.Sleep(25);
      }
    } finally { Marshal.FreeHGlobal(info); }
  }
  static void DeleteEntry(SafeFileHandle file) {
    // Remove only the selected directory entry. Clearing READONLY would change
    // every hardlink's shared attributes; unsupported filesystems fail closed.
    IntPtr info=Marshal.AllocHGlobal(4);
    try {
      Marshal.WriteInt32(info,0x13);RenameIoStatus io;
      int status=NtSetInformationFile(file,out io,info,4U,64);
      if(status<0) throw new Win32Exception((int)RtlNtStatusToDosError(status));
    } finally { Marshal.FreeHGlobal(info); }
  }
  static void Discard(SafeFileHandle file) { DeleteEntry(file); }
  static string Identity(Info info) {
    System.Globalization.CultureInfo culture=System.Globalization.CultureInfo.InvariantCulture;
    ulong index=((ulong)info.indexHigh<<32)|info.indexLow;
    return info.volume.ToString(culture)+":"+index.ToString(culture)+":"+((info.creation-116444736000000000L)*100).ToString(culture);
  }
  public static void Cleanup(string path,string identity) {
    Stage="cleanup";path=FullPath(path);
    using(PinnedParent parent=Parent(path)) {
      SafeFileHandle handle;
      try {handle=RelativeOpen(parent.Handle,parent.Leaf,false,0x130181U,0U);}
      catch(Win32Exception error) {if(error.NativeErrorCode==2 || error.NativeErrorCode==3) return;throw;}
      using(handle) {
        Info info=Information(handle,false); RequirePrivate(handle);
        if(Identity(info)!=identity) throw new UnauthorizedAccessException();
        DeleteEntry(handle);
      }
    }
  }
  public static void Write(string path,long length,bool atomic,bool readOnly,string staging,bool receipt,bool replaceExisting) {
    WriteInput(path,length,atomic,readOnly,staging,receipt,replaceExisting,Console.OpenStandardInput(),true,null);
  }
  static void WriteInput(string path,long length,bool atomic,bool readOnly,string staging,bool receipt,bool replaceExisting,Stream input,bool framedCommit,Action validateInput,Action<SafeFileHandle> prepareOutput=null,bool replacePinnedSource=false) {
    Stage="resolve";path=FullPath(path); if(length<0) throw new InvalidDataException();
    Stage="parent";using(PinnedParent parent=Parent(path)) {
      string scratch=atomic?parent.Leaf+".omnesis-"+System.Diagnostics.Process.GetCurrentProcess().Id+"-"+Guid.NewGuid().ToString("N")+".tmp":parent.Leaf;
      if(atomic && staging.Length>0) {
        if(Path.GetFileName(staging)!=staging || staging.IndexOfAny(Path.GetInvalidFileNameChars())>=0) throw new UnauthorizedAccessException();
        scratch=staging;
      }
      // FILE_CREATE binds the literal scratch leaf to the retained parent.
      // Its original protected DACL and owner are supplied to the kernel in
      // the creation call, before any plaintext can reach the file handle.
      Stage="create";
      using(SafeFileHandle createdFile=RelativeOpen(parent.Handle,scratch,false,0x1F01FFU,5U,2U,FileAcl().GetSecurityDescriptorBinaryForm()))
      using(FileStream file=new FileStream(createdFile,FileAccess.ReadWrite,65536,false)) {
        try {
          Stage="validate";Info created=Information(file.SafeFileHandle,false); RequirePrivate(file.SafeFileHandle,true);
          if(receipt) Console.Error.WriteLine("OMNESIS_PRIVATE_CREATED:"+Identity(created));
          Stage="write";byte[] bytes=new byte[65536]; long remaining=length;
          while(remaining>0) {
            int read=input.Read(bytes,0,(int)Math.Min(bytes.Length,remaining));
            if(read==0) {if(!framedCommit) Stage="copy-source-changed";throw new EndOfStreamException();}
            file.Write(bytes,0,read); remaining-=read;
          }
          Stage="commit";
          if(framedCommit) {
            byte[] commit=Encoding.ASCII.GetBytes("\0OMNESIS_PRIVATE_COMMIT_V1\0"), actual=ReadExact(commit.Length);
            for(int i=0;i<commit.Length;i++) if(actual[i]!=commit[i]) throw new InvalidDataException();
          }
          if(input.ReadByte()!=-1) {if(!framedCommit) Stage="copy-source-changed";throw new InvalidDataException();}
          if(validateInput!=null) validateInput();
          Stage="flush";file.Flush(true);
          if(prepareOutput!=null) prepareOutput(file.SafeFileHandle);
          if(readOnly) { Stage="readonly";ReadOnly(file.SafeFileHandle); }
          if(prepareOutput!=null || readOnly) file.Flush(true);
          if(atomic) { Stage="rename";Rename(file.SafeFileHandle,parent.Handle,path,replaceExisting,replacePinnedSource); }
        } catch(Exception failure) {
          string originalStage=Stage;
          try { Stage="cleanup";Discard(file.SafeFileHandle); }
          catch(Exception cleanup) {
            Win32Exception native=cleanup as Win32Exception;
            failure.Data["PrivateCleanupCode"]=native==null?cleanup.HResult&65535:native.NativeErrorCode;
          }
          Stage=originalStage;
          throw;
        }
      }
    }
  }
  static bool PrivateEnough(RawSecurityDescriptor descriptor,bool protect) {
    if(descriptor.Owner==null || !Trusted(descriptor.Owner.Value)) throw new UnauthorizedAccessException();
    return Private(descriptor,false) && (!protect || (descriptor.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0);
  }
  public static string Inspect(string path,bool directory,bool repair,bool protect) {
    Stage="inspect";path=FullPath(path);
    using(PinnedParent parent=Parent(path))
    // A file metadata handle can coexist with live readers/writers. Only actual
    // file mutation needs an exclusive content pin; directory TRAVERSE pins
    // prevent a selected directory from moving while its DACL is inspected.
    using(SafeFileHandle handle=RelativeOpen(parent.Handle,parent.Leaf,directory,0x120080U|(directory?0x20U:0U)|((repair&&directory)?0x40000U:0U),directory?3U:7U)) {
      Info original=Information(handle,directory);
      if(PrivateEnough(Security(handle),protect)) return "private";
      if(!repair) return "unsafe";
      if(directory) {Stage="repair";RepairDirectory(handle);return "fixed";}
      Stage="repair-attributes";RepairAttributes(original);
      // Only an unsafe idle source needs a readable content pin. Publication
      // creates a different private object; the old inode is never hardened.
      using(SafeFileHandle source=RelativeOpen(parent.Handle,parent.Leaf,false,0x120081U,0U)) {
        Info before=Information(source,false);
        if(Identity(before)!=Identity(original)) throw new UnauthorizedAccessException();
        if(PrivateEnough(Security(source),protect)) return "private";
        if(before.links!=1) throw new UnauthorizedAccessException();
        Stage="repair-copy";RepairFile(path,source,before);return "fixed";
      }
    }
  }
}` +
  WINDOWS_DIRECTORY_POLICY_NATIVE_SOURCE +
  WINDOWS_FILE_REPAIR_NATIVE_SOURCE;

export const WINDOWS_PRIVATE_FILE_POWERSHELL_SCRIPT = `
$ErrorActionPreference='Stop'
$WarningPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
try {
Add-Type -TypeDefinition @'
${WINDOWS_PRIVATE_FILE_NATIVE_SOURCE}
'@
$config=[OmnesisPrivateFile]::Configuration() | ConvertFrom-Json
if ($config.action -eq 'create' -or $config.action -eq 'atomic') {
  [OmnesisPrivateFile]::Write([string]$config.path,[long]$config.length,($config.action -eq 'atomic'),[bool]$config.readOnly,[string]$config.staging,[bool]$config.receipt,($null -eq $config.replaceExisting -or [bool]$config.replaceExisting))
} elseif ($config.action -eq 'storage-directory') {
  if ([Console]::OpenStandardInput().ReadByte() -ne -1) { throw 'Unexpected storage input' }
  [OmnesisPrivateFile]::PrepareStorageDirectory([string]$config.path)
} elseif ($config.action -eq 'delete') {
  [OmnesisPrivateFile]::DeleteExact([string]$config.path,[string]$config.exactBasename,[string]$config.exactParentBasename)
} elseif ($config.action -eq 'cleanup') {
  [OmnesisPrivateFile]::Cleanup([string]$config.path,[string]$config.identity)
} elseif ($config.action -eq 'inspect') {
  $results=@(foreach ($entry in $config.paths) {
    try {
      $state=[OmnesisPrivateFile]::Inspect([string]$entry.path,($entry.kind -eq 'directory'),[bool]$config.repair,[bool]$config.protect)
      @{private=($state -ne 'unsafe');fixed=($state -eq 'fixed')}
    } catch { @{private=$false;fixed=$false;error='EPRIVATE'} }
  })
  [Console]::Out.Write((ConvertTo-Json -InputObject $results -Compress))
} else { [OmnesisPrivateFile]::Read([string]$config.path,[long]$config.limit,[string]$config.exactBasename,[string]$config.exactParentBasename) }
} catch {
  $cause=$_.Exception
  $cleanupCode=$null
  while ($null -ne $cause) {
    if ($cause.Data.Contains('PrivateCleanupCode')) { $cleanupCode=$cause.Data['PrivateCleanupCode'] }
    if ($null -eq $cause.InnerException) { break }
    $cause=$cause.InnerException
  }
  $code=$cause.HResult -band 65535
  if ($cause -is [System.ComponentModel.Win32Exception]) { $code=$cause.NativeErrorCode }
  if ($null -ne $cleanupCode) { [Console]::Error.WriteLine('OMNESIS_PRIVATE_CLEANUP_FAILED:'+[string]$cleanupCode) }
  $stage='bootstrap'
  if ('OmnesisPrivateFile' -as [type]) { $stage=[OmnesisPrivateFile]::Stage }
  $category='EPRIVATE'
  if ($code -eq 2 -or $code -eq 3) { $category='ENOENT' }
  elseif ($code -eq 80 -or $code -eq 183) { $category='EEXIST' }
  [Console]::Error.Write($category+':'+$stage+':'+$code)
  exit 1
}`;
