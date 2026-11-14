// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const WINDOWS_PRIVATE_FILE_NATIVE_SOURCE = String.raw`using System;
using System.ComponentModel;
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
    uint access=0x20080U|(repair?0x40000U:0U);
    // Metadata-only handles do not participate in Windows delete-sharing
    // checks. A directory pin needs FILE_TRAVERSE (the FILE_EXECUTE bit),
    // without granting enumeration or changing metadata-only inspection.
    if(directory && (share&4U)==0) access|=0x20U;
    SafeFileHandle handle=CreateFile(path,access,share,IntPtr.Zero,3,0x200000U|(directory?0x2000000U:0U),IntPtr.Zero);
    if(handle.IsInvalid) { int code=Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(code); }
    try { Information(handle,directory); return handle; } catch { handle.Dispose(); throw; }
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
    RequirePrivate(handle,true);
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
    using(SafeFileHandle parent=Parent(path))
    using(SafeFileHandle handle=CreateFile(path,0x30180,1,IntPtr.Zero,3,0x200000,IntPtr.Zero)) {
      if(handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      Stage="validate";Information(handle,false); RequirePrivate(handle); Stage="name";Names(path,exact,exactParent);
      ReadOnly(handle,false); IntPtr disposition=Marshal.AllocHGlobal(4);
      try { Marshal.WriteInt32(disposition,1); Check(SetFileInformationByHandle(handle,4,disposition,4)); }
      finally { Marshal.FreeHGlobal(disposition); }
    }
  }
  public static void Read(string path,long limit,string exact,string exactParent) {
    Stage="resolve";path=FullPath(path);Stage="open";
    using(SafeFileHandle handle=CreateFile(path,0x80020000,1,IntPtr.Zero,3,0x200000,IntPtr.Zero)) {
      if(handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      Stage="parent";using(SafeFileHandle parent=Parent(path)) {
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
  static void ReadOnly(SafeFileHandle file,bool value) {
    IntPtr info=Marshal.AllocHGlobal(40);
    try {
      for(int i=0;i<40;i++) Marshal.WriteByte(info,i,0);
      uint attributes=Information(file,false).attributes;
      Marshal.WriteInt32(info,32,(int)(value?attributes|1:attributes&~1U));
      Check(SetFileInformationByHandle(file,0,info,40));
    } finally { Marshal.FreeHGlobal(info); }
  }
  static void Rename(SafeFileHandle file,SafeFileHandle parent,string target,bool replaceExisting) {
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
      Marshal.WriteInt32(info,0,replaceExisting?0x43:0x42); Marshal.WriteIntPtr(info,rootOffset,network?IntPtr.Zero:parent.DangerousGetHandle());
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
  static void Discard(SafeFileHandle file) {
    try { ReadOnly(file,false); } catch { }
    IntPtr info=Marshal.AllocHGlobal(4);
    try { Marshal.WriteInt32(info,1); Check(SetFileInformationByHandle(file,4,info,4)); } finally { Marshal.FreeHGlobal(info); }
  }
  static string Identity(Info info) {
    System.Globalization.CultureInfo culture=System.Globalization.CultureInfo.InvariantCulture;
    ulong index=((ulong)info.indexHigh<<32)|info.indexLow;
    return info.volume.ToString(culture)+":"+index.ToString(culture)+":"+((info.creation-116444736000000000L)*100).ToString(culture);
  }
  public static void Cleanup(string path,string identity) {
    Stage="cleanup";path=FullPath(path);
    using(SafeFileHandle parent=Parent(path)) {
      SafeFileHandle handle=CreateFile(path,0x30180,7,IntPtr.Zero,3,0x200000,IntPtr.Zero);
      using(handle) {
        if(handle.IsInvalid) {
          int code=Marshal.GetLastWin32Error(); if(code==2 || code==3) return;
          throw new Win32Exception(code);
        }
        Info info=Information(handle,false); RequirePrivate(handle);
        if(Identity(info)!=identity) throw new UnauthorizedAccessException();
        ReadOnly(handle,false); IntPtr disposition=Marshal.AllocHGlobal(4);
        try { Marshal.WriteInt32(disposition,1); Check(SetFileInformationByHandle(handle,4,disposition,4)); }
        finally { Marshal.FreeHGlobal(disposition); }
      }
    }
  }
  public static void Write(string path,long length,bool atomic,bool readOnly,string staging,bool receipt,bool replaceExisting) {
    Stage="resolve";path=FullPath(path); if(length<0) throw new InvalidDataException();
    Stage="parent";using(SafeFileHandle parent=Parent(path)) {
      string scratch=atomic?path+".omnesis-"+System.Diagnostics.Process.GetCurrentProcess().Id+"-"+Guid.NewGuid().ToString("N")+".tmp":path;
      if(atomic && staging.Length>0) {
        if(Path.GetFileName(staging)!=staging || staging.IndexOfAny(Path.GetInvalidFileNameChars())>=0) throw new UnauthorizedAccessException();
        scratch=Path.Combine(Path.GetDirectoryName(path),staging);
      }
      Stage="create";using(FileStream file=new FileStream(scratch,FileMode.CreateNew,FileSystemRights.FullControl,FileShare.Read|FileShare.Delete,65536,FileOptions.None,FileAcl())) {
        try {
          Stage="validate";Info created=Information(file.SafeFileHandle,false); RequirePrivate(file.SafeFileHandle,true);
          if(receipt) Console.Error.WriteLine("OMNESIS_PRIVATE_CREATED:"+Identity(created));
          Stage="write";Stream input=Console.OpenStandardInput(); byte[] bytes=new byte[65536]; long remaining=length;
          while(remaining>0) {
            int read=input.Read(bytes,0,(int)Math.Min(bytes.Length,remaining)); if(read==0) throw new EndOfStreamException();
            file.Write(bytes,0,read); remaining-=read;
          }
          Stage="commit";byte[] commit=Encoding.ASCII.GetBytes("\0OMNESIS_PRIVATE_COMMIT_V1\0"), actual=ReadExact(commit.Length);
          for(int i=0;i<commit.Length;i++) if(actual[i]!=commit[i]) throw new InvalidDataException();
          if(input.ReadByte()!=-1) throw new InvalidDataException();
          Stage="flush";file.Flush(true);
          if(readOnly) { Stage="readonly";ReadOnly(file.SafeFileHandle,true); }
          if(atomic) { Stage="rename";Rename(file.SafeFileHandle,parent,path,replaceExisting); }
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
  public static string Inspect(string path,bool directory,bool repair,bool protect) {
    Stage="inspect";path=FullPath(path);
    using(SafeFileHandle parent=Parent(path))
    using(SafeFileHandle handle=Open(path,directory,repair,7)) {
      RawSecurityDescriptor descriptor=Security(handle);
      if(descriptor.Owner==null || !Trusted(descriptor.Owner.Value)) throw new UnauthorizedAccessException();
      if(Private(descriptor,false) && (!protect || (descriptor.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0)) return "private";
      if(!repair) return "unsafe";
      Stage="repair";Repair(handle,directory); return "fixed";
    }
  }
}`;

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
