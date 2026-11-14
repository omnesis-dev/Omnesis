// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { WINDOWS_PRIVATE_FILE_NATIVE_SOURCE } from "./windows-private-file-source.js";

const BUILDER = String.raw`
using System;
using System.CodeDom.Compiler;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.CSharp;
using Microsoft.Win32.SafeHandles;

public static partial class OmnesisPrivateFile {
  [StructLayout(LayoutKind.Sequential)] struct Attributes {
    public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectory(string path,ref Attributes attributes);
  const int MaximumCachePins=16384; // One-character components in a 32767-character Windows path.
  const string Installer="S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out long creation,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess,IntPtr source,IntPtr targetProcess,out IntPtr target,uint access,bool inherit,uint options);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateMutex(ref Attributes attributes,bool owned,string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateEvent(ref Attributes attributes,bool manual,bool initial,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetEvent(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReleaseMutex(IntPtr handle);
  [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
  static byte[] KernelAcl(bool mutex) {
    if(mutex) {
      MutexSecurity security=new MutexSecurity();security.SetOwner(new SecurityIdentifier(User()));security.SetAccessRuleProtection(true,false);
      foreach(string sid in new string[]{User(),"S-1-5-18","S-1-5-32-544"}) security.AddAccessRule(new MutexAccessRule(new SecurityIdentifier(sid),MutexRights.FullControl,AccessControlType.Allow));
      return security.GetSecurityDescriptorBinaryForm();
    } else {
      EventWaitHandleSecurity security=new EventWaitHandleSecurity();security.SetOwner(new SecurityIdentifier(User()));security.SetAccessRuleProtection(true,false);
      foreach(string sid in new string[]{User(),"S-1-5-18","S-1-5-32-544"}) security.AddAccessRule(new EventWaitHandleAccessRule(new SecurityIdentifier(sid),EventWaitHandleRights.FullControl,AccessControlType.Allow));
      return security.GetSecurityDescriptorBinaryForm();
    }
  }
  static IntPtr KernelObject(string name,bool mutex,out bool created) {
    Stage="cache-marker-security";
    byte[] bytes=KernelAcl(mutex);GCHandle pinned=GCHandle.Alloc(bytes,GCHandleType.Pinned);IntPtr handle=IntPtr.Zero;
    try {
      Attributes attributes=new Attributes();attributes.length=Marshal.SizeOf(typeof(Attributes));attributes.descriptor=pinned.AddrOfPinnedObject();
      SetLastError(0);
      handle=mutex?CreateMutex(ref attributes,false,name):CreateEvent(ref attributes,true,false,name);
      int error=Marshal.GetLastWin32Error();created=error!=183;
      if(handle==IntPtr.Zero) throw new Win32Exception(error);
      using(SafeFileHandle borrowed=new SafeFileHandle(handle,false)) {
        RawSecurityDescriptor descriptor=Security(borrowed,6);
        if(!Private(descriptor,false) || (descriptor.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0) throw new UnauthorizedAccessException();
      }
      return handle;
    } catch {if(handle!=IntPtr.Zero) CloseHandle(handle);throw;}
    finally {pinned.Free();}
  }
  static string CacheIdentity(SafeFileHandle handle) {
    Info info=Information(handle,true);
    return info.volume.ToString(System.Globalization.CultureInfo.InvariantCulture)+":"+(((ulong)info.indexHigh<<32)|info.indexLow).ToString(System.Globalization.CultureInfo.InvariantCulture)+":"+info.creation.ToString(System.Globalization.CultureInfo.InvariantCulture);
  }
  static bool SystemAncestor(string path) {
    string system=Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.Windows)).TrimEnd(Path.DirectorySeparatorChar);
    string full=path.TrimEnd(Path.DirectorySeparatorChar);
    return String.Equals(full,Path.GetPathRoot(path).TrimEnd(Path.DirectorySeparatorChar),StringComparison.OrdinalIgnoreCase) ||
      String.Equals(full,system,StringComparison.OrdinalIgnoreCase) || full.StartsWith(system+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase);
  }
  static void RequireAncestor(SafeFileHandle handle,string path,string cache) {
    RawSecurityDescriptor descriptor=Security(handle);
    bool privateEntry=String.Equals(path,cache,StringComparison.OrdinalIgnoreCase) || path.StartsWith(cache+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase);
    bool installer=!privateEntry && SystemAncestor(path);
    if(descriptor.Owner==null || (!Trusted(descriptor.Owner.Value) && !(installer && descriptor.Owner.Value==Installer)) || descriptor.DiscretionaryAcl==null) throw new UnauthorizedAccessException();
    if(privateEntry) {RequirePrivate(handle,true);return;}
    foreach(GenericAce ace in descriptor.DiscretionaryAcl) {
      QualifiedAce rule=ace as QualifiedAce;
      if(rule==null || (rule.AceQualifier!=AceQualifier.AccessAllowed && rule.AceQualifier!=AceQualifier.AccessDenied)) throw new UnauthorizedAccessException();
      if(rule.AceQualifier!=AceQualifier.AccessAllowed || (rule.AceFlags&AceFlags.InheritOnly)!=0) continue;
      string sid=rule.SecurityIdentifier.Value;
      // Create-file/subdirectory alone cannot substitute an existing pinned
      // child. Delete/rename, ACL/owner control and mutable metadata can.
      if(!Trusted(sid) && !(installer && sid==Installer) && ((uint)rule.AccessMask&0x500D0150U)!=0) throw new UnauthorizedAccessException();
    }
  }
  sealed class CachePins : IDisposable {
    readonly List<SafeFileHandle> handles=new List<SafeFileHandle>();
    public CachePins(string path,string cache,bool allowMissing) {
      List<string> paths=new List<string>();string current=FullPath(path);
      if(current.Length>32767) throw new InvalidDataException();
      for(;;) {
        if(paths.Count>=MaximumCachePins) throw new InvalidDataException();
        paths.Add(current);
        if(String.Equals(current.TrimEnd(Path.DirectorySeparatorChar),Path.GetPathRoot(current).TrimEnd(Path.DirectorySeparatorChar),StringComparison.OrdinalIgnoreCase)) break;
        string next=Path.GetDirectoryName(current);
        if(String.IsNullOrEmpty(next) || next==current) throw new InvalidDataException();current=next;
      }
      paths.Reverse();
      try {
        foreach(string item in paths) {
          SafeFileHandle handle;
          try {handle=Open(item,true,false,3);}
          catch(Win32Exception error) {if(allowMissing && (error.NativeErrorCode==2 || error.NativeErrorCode==3)) break;throw;}
          handles.Add(handle);Stage="cache-ancestor";RequireAncestor(handle,item,cache);
        }
      } catch {Dispose();throw;}
    }
    public string GenerationIdentity() {return CacheIdentity(handles[handles.Count-1]);}
    public void Transfer(IntPtr owner,string birth,IntPtr marker) {
      Stage="cache-pin-transfer";
      List<IntPtr> transferred=new List<IntPtr>();
      try {
        RequireOwner(owner,birth);
        // Marker FIRST: a crashed bootstrap leaves one incomplete state in the
        // original Node, rather than allowing another worker to add a pin set.
        IntPtr markerCopy;Check(DuplicateHandle(GetCurrentProcess(),marker,owner,out markerCopy,0,false,2));
        transferred.Add(markerCopy);
        foreach(SafeFileHandle handle in handles) {
          IntPtr copied;Check(DuplicateHandle(GetCurrentProcess(),handle.DangerousGetHandle(),owner,out copied,0,false,2));
          transferred.Add(copied);
        }
        RequireOwner(owner,birth);Check(SetEvent(marker));
      } catch(Exception failure) {
        List<Exception> errors=new List<Exception>();errors.Add(failure);
        // Directories first; preserve the unsignaled marker if any rollback is
        // uncertain. Its Node-held handle keeps all later workers fail closed.
        for(int index=transferred.Count-1;index>=0;index--) {
          if(index==0 && errors.Count>1) break;
          if(WaitForSingleObject(owner,0)==0) break;
          IntPtr copied;
          if(DuplicateHandle(owner,transferred[index],GetCurrentProcess(),out copied,0,false,3)) CloseHandle(copied);
          else if(WaitForSingleObject(owner,0)!=0) errors.Add(new Win32Exception(Marshal.GetLastWin32Error()));
        }
        if(errors.Count>1) throw new AggregateException(errors);throw;
      }
    }
    public void Dispose() {foreach(SafeFileHandle handle in handles) handle.Dispose();handles.Clear();}
  }
  static void RequireOwner(IntPtr owner,string birth) {
    Stage="cache-owner";
    long creation,exit,kernel,user;Check(GetProcessTimes(owner,out creation,out exit,out kernel,out user));
    if(WaitForSingleObject(owner,0)!=258 || creation.ToString(System.Globalization.CultureInfo.InvariantCulture)!=birth) throw new UnauthorizedAccessException();
  }
  static string PinWinner(string directory,string sourceHash,string config,int ownerPid,string ownerBirth) {
    if(ownerPid<=0 || !System.Text.RegularExpressions.Regex.IsMatch(ownerBirth,@"^[0-9]{1,19}$")) throw new InvalidDataException();
    IntPtr owner=OpenProcess(0x101040,false,ownerPid);
    if(owner==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      RequireOwner(owner,ownerBirth);
      string cache=Path.GetDirectoryName(directory);
      using(CachePins pins=new CachePins(directory,cache,false)) {
        string record=Winner(directory,sourceHash,config);
        JavaScriptSerializer serializer=new JavaScriptSerializer();
        Dictionary<string,object> response=serializer.DeserializeObject(record) as Dictionary<string,object>;
        response["ownerPid"]=ownerPid;response["ownerBirth"]=ownerBirth;response["pinsTransferred"]=true;
        string json=serializer.Serialize(response);
        string rootIdentity;
        using(SafeFileHandle rootHandle=Open(cache,true,false,3)) rootIdentity=CacheIdentity(rootHandle);
        string key="Local\\OmnesisPlatformPins-"+ownerPid.ToString(System.Globalization.CultureInfo.InvariantCulture)+"-"+ownerBirth+"-"+sourceHash+"-"+Hash(Encoding.UTF8.GetBytes(rootIdentity+"|"+pins.GenerationIdentity()));
        response["pinKey"]=key;json=serializer.Serialize(response);
        bool created;IntPtr mutex=KernelObject(key+".mutex",true,out created),marker=IntPtr.Zero;bool locked=false;
        try {
          Stage="cache-marker-wait";uint waited=WaitForSingleObject(mutex,30000);
          if(waited!=0 && waited!=128) throw new UnauthorizedAccessException();locked=true;
          RequireOwner(owner,ownerBirth);
          marker=KernelObject(key+".ready",false,out created);
          if(created) pins.Transfer(owner,ownerBirth,marker);
          else {Stage="cache-marker-state";if(WaitForSingleObject(marker,0)!=0) throw new UnauthorizedAccessException();}
          RequireOwner(owner,ownerBirth);
        } finally {
          if(marker!=IntPtr.Zero) CloseHandle(marker);
          if(locked) ReleaseMutex(mutex);CloseHandle(mutex);
        }
        return json;
      }
    } finally {CloseHandle(owner);}
  }
  static DirectorySecurity CacheDirectoryAcl() {
    DirectorySecurity security=new DirectorySecurity();security.SetOwner(new SecurityIdentifier(User()));security.SetAccessRuleProtection(true,false);
    foreach(string sid in new string[]{User(),"S-1-5-18","S-1-5-32-544"}) security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
    return security;
  }
  static void NewCacheDirectory(string path) {
    byte[] bytes=CacheDirectoryAcl().GetSecurityDescriptorBinaryForm();GCHandle pinned=GCHandle.Alloc(bytes,GCHandleType.Pinned);
    try {
      Attributes attributes=new Attributes();attributes.length=Marshal.SizeOf(typeof(Attributes));attributes.descriptor=pinned.AddrOfPinnedObject();
      Check(CreateDirectory(path,ref attributes));
    } finally {pinned.Free();}
  }
  static string Hash(byte[] bytes) {using(SHA256 hash=SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
  static void CacheWrite(string path,byte[] bytes) {
    using(FileStream file=new FileStream(path,FileMode.CreateNew,FileSystemRights.FullControl,FileShare.Read|FileShare.Delete,4096,FileOptions.None,FileAcl())) {
      RequirePrivate(file.SafeFileHandle,true);file.Write(bytes,0,bytes.Length);file.Flush(true);
    }
  }
  static byte[] CacheRead(string path,int maximum) {
    using(SafeFileHandle parent=Parent(path))
    using(SafeFileHandle handle=CreateFile(path,0x80020000,5,IntPtr.Zero,3,0x200000,IntPtr.Zero)) {
      if(handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      Info info=Information(handle,false);RequirePrivate(handle,true);
      if(info.sizeHigh!=0 || info.sizeLow>maximum) throw new InvalidDataException();
      using(FileStream file=new FileStream(handle,FileAccess.Read)) {
        byte[] bytes=new byte[(int)info.sizeLow];int count=0,read;
        while(count<bytes.Length && (read=file.Read(bytes,count,bytes.Length-count))!=0) count+=read;
        if(count!=bytes.Length || file.ReadByte()!=-1) throw new InvalidDataException();return bytes;
      }
    }
  }
  static string Winner(string directory,string sourceHash,string config) {
    Stage="cache-verify";
    using(SafeFileHandle parent=Parent(directory))
    using(SafeFileHandle handle=Open(directory,true,false,3)) {RequirePrivate(handle,true);}
    string executable=Path.Combine(directory,"worker.exe");
    byte[] binary=CacheRead(executable,16777216),recordBytes=CacheRead(Path.Combine(directory,"manifest.json"),16384);
    JavaScriptSerializer serializer=new JavaScriptSerializer {MaxJsonLength=16384,RecursionLimit=8};
    Dictionary<string,object> record=serializer.DeserializeObject(new UTF8Encoding(false,true).GetString(recordBytes)) as Dictionary<string,object>;
    if(record==null || record.Count!=3 || !record.ContainsKey("format") || Convert.ToInt32(record["format"])!=1 || !record.ContainsKey("sourceHash") || (string)record["sourceHash"]!=sourceHash || !record.ContainsKey("binaryHash") || (string)record["binaryHash"]!=Hash(binary)) throw new InvalidDataException();
    if(new UTF8Encoding(false,true).GetString(CacheRead(executable+".config",65536))!=config) throw new InvalidDataException();
    return serializer.Serialize(new Dictionary<string,object>{{"executable",executable},{"sourceHash",sourceHash},{"binaryHash",record["binaryHash"]}});
  }
  public static string Cache(string root,string sourceHash,int length,string config,string manifest,int ownerPid,string ownerBirth) {
    Stage="cache-input";
    if(sourceHash.Length!=64 || length<=0 || length>1048576 || config.Length>65536 || manifest.Length>65536) throw new InvalidDataException();
    foreach(char c in sourceHash) if(!((c>='0'&&c<='9')||(c>='a'&&c<='f'))) throw new InvalidDataException();
    byte[] expected=Encoding.ASCII.GetBytes("\0OMNESIS_PRIVATE_COMMIT_V1\0");
    byte[] source=ReadExact(length),commit=ReadExact(expected.Length);
    if(commit.Length!=expected.Length) throw new InvalidDataException();
    for(int i=0;i<commit.Length;i++) if(commit[i]!=expected[i]) throw new InvalidDataException();
    string code=new UTF8Encoding(false,true).GetString(source);
    if(Hash(Encoding.UTF8.GetBytes(code+"\0"+config+"\0"+manifest+"\0v1"))!=sourceHash) throw new InvalidDataException();
    root=FullPath(root);
    using(CachePins existing=new CachePins(root,root,true)) {
      if(!Directory.Exists(root)) Directory.CreateDirectory(root,CacheDirectoryAcl());
    }
    using(CachePins ancestors=new CachePins(root,root,false))
    using(SafeFileHandle rootParent=Parent(root))
    using(SafeFileHandle rootHandle=Open(root,true,false,3)) {
      RequirePrivate(rootHandle,true);
      string winner=Path.Combine(root,sourceHash);
      if(Directory.Exists(winner)) return PinWinner(winner,sourceHash,config,ownerPid,ownerBirth);
      string staging=Path.Combine(root,".build-"+System.Diagnostics.Process.GetCurrentProcess().Id+"-"+Guid.NewGuid().ToString("N"));
      bool created=false,published=false;
      try {
        NewCacheDirectory(staging);created=true;
        using(SafeFileHandle handle=Open(staging,true,false,3)) {RequirePrivate(handle,true);}
        string executable=Path.Combine(staging,"worker.exe"),manifestPath=Path.Combine(staging,"worker.manifest");
        CacheWrite(manifestPath,Encoding.UTF8.GetBytes(manifest));
        Stage="cache-compile";using(CSharpCodeProvider compiler=new CSharpCodeProvider()) {
          CompilerParameters options=new CompilerParameters();options.GenerateExecutable=true;options.GenerateInMemory=false;options.OutputAssembly=executable;options.MainClass="OmnesisPlatform.WindowsWorker";
          options.CompilerOptions="/optimize+ /debug- /win32manifest:\""+manifestPath+"\"";
          options.ReferencedAssemblies.Add("System.dll");options.ReferencedAssemblies.Add("System.Core.dll");options.ReferencedAssemblies.Add("System.Web.Extensions.dll");
          options.TempFiles=new TempFileCollection(staging,false);
          try {
            CompilerResults result=compiler.CompileAssemblyFromSource(options,code);
            if(result.Errors.HasErrors) {
              int reported=0;
              foreach(CompilerError error in result.Errors) {
                if(error.IsWarning || !System.Text.RegularExpressions.Regex.IsMatch(error.ErrorNumber,@"^CS[0-9]+$")) continue;
                Console.Error.WriteLine("OMNESIS_NATIVE_COMPILE:"+error.ErrorNumber+":"+error.Line.ToString(System.Globalization.CultureInfo.InvariantCulture)+":"+error.Column.ToString(System.Globalization.CultureInfo.InvariantCulture));
                if(++reported>=5) break;
              }
              throw new InvalidDataException();
            }
          }
          finally {options.TempFiles.Delete();}
        }
        using(SafeFileHandle handle=Open(executable,false,true,7)) {
          RawSecurityDescriptor descriptor=Security(handle);
          if(descriptor.Owner==null || !Trusted(descriptor.Owner.Value)) throw new UnauthorizedAccessException();
          Repair(handle,false);
        }
        File.Delete(manifestPath);
        CacheWrite(executable+".config",Encoding.UTF8.GetBytes(config));
        string binaryHash=Hash(CacheRead(executable,16777216));
        JavaScriptSerializer serializer=new JavaScriptSerializer();
        CacheWrite(Path.Combine(staging,"manifest.json"),Encoding.UTF8.GetBytes(serializer.Serialize(new Dictionary<string,object>{{"format",1},{"sourceHash",sourceHash},{"binaryHash",binaryHash}})));
        Winner(staging,sourceHash,config);
        try {Directory.Move(staging,winner);published=true;}
        catch(IOException) {if(!Directory.Exists(winner)) throw;}
        return PinWinner(winner,sourceHash,config,ownerPid,ownerBirth);
      } finally {
        // Only this process's successful CREATE_NEW directory is removed.
        // A competing publisher's generation and preexisting paths are untouched.
        if(created && !published && Directory.Exists(staging)) Directory.Delete(staging,true);
      }
    }
  }
}
`;

export const WINDOWS_CACHE_BOOTSTRAP_SCRIPT = `
$ErrorActionPreference='Stop'
$WarningPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll','Microsoft.CSharp.dll') -TypeDefinition @'
namespace OmnesisBootstrap {
${WINDOWS_PRIVATE_FILE_NATIVE_SOURCE}
}
namespace OmnesisBootstrap {
${BUILDER}
}
'@
$config=[OmnesisBootstrap.OmnesisPrivateFile]::Configuration() | ConvertFrom-Json
[Console]::Out.Write([OmnesisBootstrap.OmnesisPrivateFile]::Cache([string]$config.root,[string]$config.sourceHash,[int]$config.length,[string]$config.runtimeConfig,[string]$config.manifest,[int]$config.ownerPid,[string]$config.ownerBirth))
} catch {
  $cause=$_.Exception
  while ($null -ne $cause.InnerException) { $cause=$cause.InnerException }
  $code=$cause.HResult -band 65535
  if ($cause -is [ComponentModel.Win32Exception]) { $code=$cause.NativeErrorCode }
  $stage='bootstrap'
  if ('OmnesisBootstrap.OmnesisPrivateFile' -as [type]) { $stage=[OmnesisBootstrap.OmnesisPrivateFile]::Stage }
  [Console]::Error.Write('EPRIVATE:'+ $stage +':'+[string]$code)
  exit 1
}
`;
