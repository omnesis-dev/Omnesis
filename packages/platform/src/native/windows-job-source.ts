// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { gzipSync } from "node:zlib";

export const WINDOWS_JOB_NATIVE_SOURCE = String.raw`using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static partial class OmnesisProcessJob {
  const uint SYNCHRONIZE=0x100000, QUERY=0x1000, INHERIT=1;
  const uint SUSPENDED=4, EXTENDED=0x80000, NO_WINDOW=0x8000000;
  const uint KILL_ON_CLOSE=0x2000, WAIT_OBJECT=0, STILL_ACTIVE=259;
  [StructLayout(LayoutKind.Sequential)] struct Startup {
    public uint cb; public IntPtr reserved, desktop, title;
    public uint x,y,xSize,ySize,xChars,yChars,fill,flags;
    public ushort show,reservedSize; public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking;
    public uint processCount; public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimits basic; public IoCounters io;
    public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long user,kernel,periodUser,periodKernel;
    public uint faults,total,active,terminated;
  }
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint low,high; public ulong Value { get { return ((ulong)high<<32)|low; } } }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr h,byte[] b,uint count,out uint read,IntPtr overlap);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr h,byte[] b,uint count,out uint written,IntPtr overlap);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref Limits limits,uint length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,uint length,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref StartupEx startup,out ProcessInfo process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out FileTime creation,out FileTime exit,out FileTime kernel,out FileTime user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)] struct ControlOverlapped {
    public UIntPtr status, transferred; public uint offset, offsetHigh; public IntPtr signal;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="CreateFileW")] static extern IntPtr OpenControlPipe(string path,uint access,uint sharing,IntPtr security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,EntryPoint="WaitNamedPipeW")] static extern bool WaitControlPipe(string path,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeInfo(IntPtr pipe,out uint flags,IntPtr output,IntPtr input,IntPtr instances);
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateEvent(IntPtr attributes,bool manual,bool initial,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ResetEvent(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr handle,IntPtr bytes,uint length,IntPtr transferred,IntPtr overlap);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr handle,IntPtr bytes,uint length,IntPtr transferred,IntPtr overlap);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetOverlappedResultEx(IntPtr handle,IntPtr overlap,out uint transferred,uint milliseconds,bool alertable);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CancelIoEx(IntPtr handle,IntPtr overlap);
  sealed class ControlIo : IDisposable {
    readonly IntPtr handle; readonly int capacity;
    IntPtr buffer,overlap,signal; bool pending,cancellationAttempted;
    public uint Count; public int Error;
    public ControlIo(IntPtr handle,int capacity) {
      this.handle=handle;this.capacity=capacity;
      try {
        signal=CreateEvent(IntPtr.Zero,true,false,null);if(signal==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        buffer=Marshal.AllocHGlobal(capacity);overlap=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ControlOverlapped)));
      } catch {Dispose();throw;}
    }
    public bool Begin(byte[] bytes) {
      if(pending || (bytes!=null && bytes.Length>capacity)) throw new InvalidDataException("Invalid control operation");
      Check(ResetEvent(signal));Marshal.StructureToPtr(new ControlOverlapped {signal=signal},overlap,false);
      Count=0;Error=0;cancellationAttempted=false;
      if(bytes!=null) Marshal.Copy(bytes,0,buffer,bytes.Length);
      bool complete=bytes==null ? ReadFile(handle,buffer,1,IntPtr.Zero,overlap) : WriteFile(handle,buffer,(uint)bytes.Length,IntPtr.Zero,overlap);
      if(!complete) {int error=Marshal.GetLastWin32Error();if(error!=997) {Error=error;return false;}}
      pending=true;return true;
    }
    public bool Observe(uint milliseconds) {
      if(!pending) return true;
      uint count;
      if(!GetOverlappedResultEx(handle,overlap,out count,milliseconds,false)) {
        int error=Marshal.GetLastWin32Error();
        if(error==258 || error==996) return false;
        // Invalid API state is not evidence that pending I/O completed.
        if(error==6 || error==87) throw new Win32Exception(error,"Invalid control I/O state");
        pending=false;Error=error;Count=count;return true;
      }
      pending=false;Error=0;Count=count;return true;
    }
    public byte Value {get {if(pending || Error!=0 || Count!=1) throw new IOException("Invalid control byte");return Marshal.ReadByte(buffer);}}
    public void CancelAndJoin() {
      if(!pending) return;
      if(cancellationAttempted) throw new IOException("Control cancellation was not confirmed");
      cancellationAttempted=true;
      if(!CancelIoEx(handle,overlap)) {int error=Marshal.GetLastWin32Error();if(error!=1168) throw new Win32Exception(error,"Control cancellation failed");}
      if(!Observe(1000)) throw new TimeoutException("Control I/O did not complete");
      // ERROR_OPERATION_ABORTED is a completed cancellation. Other completed
      // results are also safe to release, but never imply a protocol ACK.
    }
    public void Dispose() {
      // Never free an OVERLAPPED/buffer still referenced by kernel I/O. On a
      // failed bounded cancellation these few bytes live until helper exit.
      if(pending) return;
      if(overlap!=IntPtr.Zero) {Marshal.FreeHGlobal(overlap);overlap=IntPtr.Zero;}
      if(buffer!=IntPtr.Zero) {Marshal.FreeHGlobal(buffer);buffer=IntPtr.Zero;}
      if(signal!=IntPtr.Zero) {CloseHandle(signal);signal=IntPtr.Zero;}
    }
  }
  sealed class JobControl : IDisposable {
    Microsoft.Win32.SafeHandles.SafeFileHandle pipe;
    ControlIo read,write; readonly IntPtr parent; readonly long deadline;
    bool cancelled,completed;
    static bool Hex(string value,int length) {
      if(value==null || value.Length!=length) return false;
      foreach(char c in value) if(!((c>='0'&&c<='9')||(c>='a'&&c<='f'))) return false;
      return true;
    }
    static long Now() {return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();}
    uint Remaining() {
      long remaining=deadline-Now();if(remaining<=0) throw new TimeoutException("Control setup timed out");return (uint)Math.Min(remaining,30000);
    }
    void Write(byte[] bytes,uint timeout) {
      if(!write.Begin(bytes) || !write.Observe(timeout) || write.Error!=0 || write.Count!=bytes.Length)
        throw new IOException("Control write failed");
    }
    public JobControl(string name,string cookie,int parentPid,string parentBirth,long requestedDeadline,IntPtr retainedParent) {
      parent=retainedParent;deadline=Math.Min(requestedDeadline,Now()+30000);
      string prefix="omnesis-job-"+parentPid.ToString(System.Globalization.CultureInfo.InvariantCulture)+"-";
      ulong expected;
      if(name==null || !name.StartsWith(prefix,StringComparison.Ordinal) || !Hex(name.Substring(prefix.Length),48) || !Hex(cookie,64) ||
        !UInt64.TryParse(parentBirth,System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out expected) || expected==0)
        throw new InvalidDataException("Invalid local control configuration");
      try {
        if(Birth(parent)!=expected || WaitForSingleObject(parent,0)==WAIT_OBJECT) throw new UnauthorizedAccessException();
        string path=@"\\.\pipe\"+name;
        for(;;) {
          Remaining();
          if(WaitForSingleObject(parent,0)==WAIT_OBJECT) throw new IOException("Control owner exited");
          // A managed asynchronous PipeStream binds its handle to CLR IOCP,
          // which cannot dispatch our unmanaged OVERLAPPED storage. Open a raw
          // overlapped handle instead; anonymous SQOS prevents impersonation.
          IntPtr opened=OpenControlPipe(path,0xC0000000U,0U,IntPtr.Zero,3U,0x40100000U,IntPtr.Zero);
          if(opened!=new IntPtr(-1)) {
            if(opened==IntPtr.Zero) throw new IOException("Invalid control handle");
            pipe=new Microsoft.Win32.SafeHandles.SafeFileHandle(opened,true);break;
          }
          int error=Marshal.GetLastWin32Error();
          if(error!=231) throw new Win32Exception(error,"Control connection failed");
          if(!WaitControlPipe(path,Math.Min(Remaining(),25))) {
            error=Marshal.GetLastWin32Error();
            if(error!=121) throw new Win32Exception(error,"Control connection failed");
          }
        }
        IntPtr handle=pipe.DangerousGetHandle();uint server,flags;
        Check(GetNamedPipeServerProcessId(handle,out server));Check(GetNamedPipeInfo(handle,out flags,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero));
        if(server!=(uint)parentPid || Birth(parent)!=expected || WaitForSingleObject(parent,0)==WAIT_OBJECT || (flags&4)!=0) throw new UnauthorizedAccessException();
        Check(SetHandleInformation(handle,INHERIT,0));
        read=new ControlIo(handle,1);write=new ControlIo(handle,256);
        // Endpoint ownership is verified before the cookie leaves the framed
        // private stdin. The target never inherits this control handle.
        Write(Encoding.ASCII.GetBytes("{\"cookie\":\""+cookie+"\",\"pid\":"+GetCurrentProcessId().ToString(System.Globalization.CultureInfo.InvariantCulture)+"}\n"),Remaining());
        if(!read.Begin(null)) throw new IOException("Control ACK missing");
        for(;;) {
          if(WaitForSingleObject(parent,0)==WAIT_OBJECT) throw new IOException("Control owner exited");
          if(read.Observe(Math.Min(Remaining(),25))) break;
        }
        if(read.Error!=0 || read.Count!=1 || read.Value!=0) throw new IOException("Control ACK missing");
        // One-byte reads preserve a cancel coalesced with the ACK in the pipe.
        if(!read.Begin(null)) cancelled=true;
      } catch {
        Dispose();throw new IOException("Windows process control setup failed");
      }
    }
    public bool Cancelled {
      get {
        if(cancelled) return true;
        if(!read.Observe(0)) return false;
        cancelled=true;
        if(read.Error==0 && read.Count==1 && read.Value!=1) throw new InvalidDataException("Invalid control cancellation");
        return true;
      }
    }
    public void Joined() {
      read.CancelAndJoin();
      if(read.Error!=995 && (read.Error!=0 || read.Count!=1 || read.Value!=1))
        throw new IOException("Control read completion was not confirmed");
      Write(new byte[]{2},1000);
      completed=true;
    }
    public void Dispose() {
      try {
        if(!completed) {
          try {if(read!=null) read.CancelAndJoin();} catch {}
          try {if(write!=null) write.CancelAndJoin();} catch {}
        }
      } finally {
        if(pipe!=null) {pipe.Dispose();pipe=null;}
        if(read!=null) {read.Dispose();read=null;}
        if(write!=null) {write.Dispose();write=null;}
      }
    }
  }

  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static ulong Birth(IntPtr process) { FileTime a,b,c,d; Check(GetProcessTimes(process,out a,out b,out c,out d)); return a.Value; }
  static byte[] ReadExact(int count) {
    byte[] result=new byte[count]; int offset=0;
    while(offset<count) {
      byte[] part=new byte[count-offset]; uint read;
      Check(ReadFile(GetStdHandle(-10),part,(uint)part.Length,out read,IntPtr.Zero));
      if(read==0) throw new EndOfStreamException("Incomplete process configuration");
      Buffer.BlockCopy(part,0,result,offset,(int)read); offset+=(int)read;
    }
    return result;
  }
  public static string ReadConfiguration() {
    uint count=BitConverter.ToUInt32(ReadExact(4),0);
    if(count==0 || count>262144) throw new InvalidDataException("Invalid process configuration length");
    return new UTF8Encoding(false,true).GetString(ReadExact((int)count));
  }
  static void Status(int code) {
    byte[] bytes=Encoding.ASCII.GetBytes("OMNESIS_JOB:"+code.ToString()+"\n"); uint written;
    Check(WriteFile(GetStdHandle(-12),bytes,(uint)bytes.Length,out written,IntPtr.Zero));
    if(written!=bytes.Length) throw new IOException("Incomplete process status");
  }
  static string Quote(string value) {
    StringBuilder result=new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      if(c=='\"') { result.Append('\\',slashes*2+1); result.Append(c); }
      else { result.Append('\\',slashes); result.Append(c); }
      slashes=0;
    }
    result.Append('\\',slashes*2); result.Append('\"'); return result.ToString();
  }
  public static int Run(string command,string[] args,int parentPid) {
    return Run(command,args,parentPid,"tree");
  }
  public static int Run(string command,string[] args,int parentPid,string completion) {
    return Run(command,args,parentPid,completion,null,null,null,0);
  }
  // PowerShell coerces null arguments at the managed boundary; keep control
  // nulls inside C# for the synchronous, non-cooperative entrypoint.
  public static int RunSync(string command,string[] args,int parentPid,string completion,string syncReceipt) {
    return Run(command,args,parentPid,completion,null,null,null,0,syncReceipt);
  }
  static string completedSyncReceipt;
  public static void WriteSyncReceipt() {
    string nonce=System.Threading.Interlocked.Exchange(ref completedSyncReceipt,null);
    if(nonce!=null) Console.Error.Write("\nOMNESIS_JOB_JOINED:"+nonce+"\n");
  }
  public static int Run(string command,string[] args,int parentPid,string completion,string controlPipe,string controlCookie,string parentBirth,long controlDeadline) {
    return Run(command,args,parentPid,completion,controlPipe,controlCookie,parentBirth,controlDeadline,null);
  }
  public static int Run(string command,string[] args,int parentPid,string completion,string controlPipe,string controlCookie,string parentBirth,long controlDeadline,string syncReceipt) {
    System.Threading.Interlocked.Exchange(ref completedSyncReceipt,null);
    if(syncReceipt!=null && !System.Text.RegularExpressions.Regex.IsMatch(syncReceipt,"\\A[0-9a-f]{64}\\z")) throw new InvalidDataException("Invalid synchronous completion metadata");
    if(completion!="tree" && completion!="root") throw new InvalidDataException("Invalid process completion policy");
    IntPtr parent=IntPtr.Zero,job=IntPtr.Zero,list=IntPtr.Zero,handles=IntPtr.Zero,jobs=IntPtr.Zero;
    ProcessInfo process=new ProcessInfo(); bool assigned=false,initialized=false,joined=false,setupFinished=false;
    JobControl control=null;Exception operationFailure=null;
    try {
      parent=OpenProcess(SYNCHRONIZE|QUERY,false,(uint)parentPid);
      if(parent==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      // The actual parent existed before this helper; a reused PID did not.
      if(Birth(parent)>Birth(GetCurrentProcess()) || WaitForSingleObject(parent,0)==WAIT_OBJECT)
        throw new InvalidOperationException("Process launcher parent exited");
      job=CreateJobObject(IntPtr.Zero,null);
      if(job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      Limits limits=new Limits(); limits.basic.flags=KILL_ON_CLOSE;
      Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))));
      if(controlPipe!=null) control=new JobControl(controlPipe,controlCookie,parentPid,parentBirth,controlDeadline,parent);
      if(control!=null && control.Cancelled) {setupFinished=true;return 1;}
      StartupEx startup=new StartupEx(); startup.startup.cb=(uint)Marshal.SizeOf(typeof(StartupEx)); startup.startup.flags=0x100;
      startup.startup.input=GetStdHandle(-10); startup.startup.output=GetStdHandle(-11); startup.startup.error=GetStdHandle(-12);
      IntPtr[] values={startup.startup.input,startup.startup.output,startup.startup.error};
      foreach(IntPtr handle in values) Check(SetHandleInformation(handle,INHERIT,INHERIT));
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);
      list=Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(list,2,0,ref size)); initialized=true;
      handles=Marshal.AllocHGlobal(IntPtr.Size*values.Length); Marshal.Copy(values,0,handles,values.Length);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*values.Length),IntPtr.Zero,IntPtr.Zero));
      // JOB_LIST makes ownership atomic with creation, including helper death
      // inside CreateProcess; post-creation assignment leaves a suspended orphan.
      jobs=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs,job);
      Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x2000D),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      startup.attributes=list;
      StringBuilder line=new StringBuilder(Quote(command));
      foreach(string arg in args) line.Append(' ').Append(Quote(arg));
      if(line.Length>=32767) throw new InvalidDataException("Process command line exceeds the Windows limit");
      // Keep the quoted executable and existing Windows PATH/extension lookup
      // semantics for bare commands; no shell interprets this command line.
      if(!CreateProcess(null,line,IntPtr.Zero,IntPtr.Zero,true,SUSPENDED|EXTENDED|NO_WINDOW,IntPtr.Zero,null,ref startup,out process)) {
        setupFinished=true;Status(Marshal.GetLastWin32Error()); return 1;
      }
      assigned=true;
      if(WaitForSingleObject(parent,0)==WAIT_OBJECT || (control!=null && control.Cancelled)) {
        setupFinished=true;Check(TerminateJobObject(job,1));return 1;
      }
      Status(0);
      if(ResumeThread(process.thread)==UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
      // All creation/assignment runs synchronously on this thread. Neither
      // cancellation nor JOINED can race an in-flight CreateProcess call.
      setupFinished=true;
      uint exit=STILL_ACTIVE; bool exited=false,remainingTerminated=false,cancelled=false;
      for(;;) {
        if(WaitForSingleObject(parent,0)==WAIT_OBJECT || (control!=null && control.Cancelled)) {
          cancelled=true;if(!remainingTerminated) {Check(TerminateJobObject(job,1));remainingTerminated=true;}
        }
        if(!exited && WaitForSingleObject(process.process,0)==WAIT_OBJECT) { Check(GetExitCodeProcess(process.process,out exit)); exited=true; }
        Accounting accounting; Check(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
        if(setupFinished && (exited || cancelled) && accounting.active==0) {joined=true;return cancelled ? 1 : unchecked((int)exit);}
        // The retained root handle proves completion. Cache its status before
        // terminating only members of this owned Job, then join active==0.
        if(exited && completion=="root" && !remainingTerminated) {
          Check(TerminateJobObject(job,1)); remainingTerminated=true;
        }
        System.Threading.Thread.Sleep(25);
      }
    } catch(Exception error) {setupFinished=true;operationFailure=error;throw;} finally {
      bool cleanupFailed=false;
      try {
        if(process.process!=IntPtr.Zero && !assigned) {
          Check(TerminateProcess(process.process,1));
          if(WaitForSingleObject(process.process,1000)!=WAIT_OBJECT) throw new IOException("Unassigned process did not exit");
        }
        if(job!=IntPtr.Zero && !joined) {
          Check(TerminateJobObject(job,1));System.Diagnostics.Stopwatch cleanupClock=System.Diagnostics.Stopwatch.StartNew();
          for(;;) {
            Accounting accounting;Check(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
            if(accounting.active==0) {joined=true;break;}
            if(cleanupClock.ElapsedMilliseconds>=1000) throw new IOException("Owned job did not drain");
            System.Threading.Thread.Sleep(5);
          }
        }
        if(control!=null) {
          if(!setupFinished || !joined) throw new IOException("Owned process setup or drain was not confirmed");
          control.Joined();
        }
      } catch {cleanupFailed=true;}
      try {if(control!=null) control.Dispose();} catch {cleanupFailed=true;}
      if(process.thread!=IntPtr.Zero && !CloseHandle(process.thread)) cleanupFailed=true;
      if(process.process!=IntPtr.Zero && !CloseHandle(process.process)) cleanupFailed=true;
      if(initialized) DeleteProcThreadAttributeList(list);
      if(list!=IntPtr.Zero) Marshal.FreeHGlobal(list);
      if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if(jobs!=IntPtr.Zero) Marshal.FreeHGlobal(jobs);
      if(job!=IntPtr.Zero && !CloseHandle(job)) cleanupFailed=true;
      if(parent!=IntPtr.Zero && !CloseHandle(parent)) cleanupFailed=true;
      if(cleanupFailed) {
        if(operationFailure==null) throw new IOException("Owned process cleanup was not confirmed");
        Console.Error.WriteLine("EJOB:unjoined-cleanup");
      }
      if(!cleanupFailed && setupFinished && joined && syncReceipt!=null)
        System.Threading.Interlocked.Exchange(ref completedSyncReceipt,syncReceipt);
    }
  }
}`;

export const WINDOWS_JOB_POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$code = 1
try {
$compressed=[Convert]::FromBase64String('${gzipSync(Buffer.from(WINDOWS_JOB_NATIVE_SOURCE, "utf8")).toString("base64")}')
$compressedStream=[IO.MemoryStream]::new($compressed)
$sourceStream=[IO.Compression.GZipStream]::new($compressedStream,[IO.Compression.CompressionMode]::Decompress)
$sourceReader=[IO.StreamReader]::new($sourceStream,[Text.Encoding]::UTF8)
try { $source=$sourceReader.ReadToEnd() } finally { $sourceReader.Dispose();$compressedStream.Dispose() }
Add-Type -ReferencedAssemblies @('System.dll','System.Core.dll') -TypeDefinition $source
$config = [OmnesisProcessJob]::ReadConfiguration() | ConvertFrom-Json
$completion = 'tree'
if ($null -ne $config.PSObject.Properties['completion']) { $completion = [string]$config.completion }
if ($null -ne $config.PSObject.Properties['syncReceipt']) {
  $code = [OmnesisProcessJob]::RunSync([string]$config.command, [string[]]$config.args, [int]$config.parentPid, $completion, [string]$config.syncReceipt)
} else {
  $code = [OmnesisProcessJob]::Run([string]$config.command, [string[]]$config.args, [int]$config.parentPid, $completion)
}
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $code = 1
}
if ($null -ne ('OmnesisProcessJob' -as [type])) { [OmnesisProcessJob]::WriteSyncReceipt() }
exit $code
`;
