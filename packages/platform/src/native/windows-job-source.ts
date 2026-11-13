// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

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
    IntPtr parent=IntPtr.Zero,job=IntPtr.Zero,list=IntPtr.Zero,handles=IntPtr.Zero,jobs=IntPtr.Zero;
    ProcessInfo process=new ProcessInfo(); bool assigned=false,initialized=false;
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
      if(!CreateProcess(null,line,IntPtr.Zero,IntPtr.Zero,true,SUSPENDED|EXTENDED|NO_WINDOW,IntPtr.Zero,null,ref startup,out process)) {
        Status(Marshal.GetLastWin32Error()); return 1;
      }
      assigned=true;
      Status(0);
      if(ResumeThread(process.thread)==UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint exit=STILL_ACTIVE; bool exited=false;
      for(;;) {
        if(WaitForSingleObject(parent,0)==WAIT_OBJECT) { Check(TerminateJobObject(job,1)); return 1; }
        if(!exited && WaitForSingleObject(process.process,0)==WAIT_OBJECT) { Check(GetExitCodeProcess(process.process,out exit)); exited=true; }
        Accounting accounting; Check(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
        if(exited && accounting.active==0) return unchecked((int)exit);
        System.Threading.Thread.Sleep(25);
      }
    } finally {
      if(process.process!=IntPtr.Zero && !assigned) TerminateProcess(process.process,1);
      if(process.thread!=IntPtr.Zero) CloseHandle(process.thread);
      if(process.process!=IntPtr.Zero) CloseHandle(process.process);
      if(initialized) DeleteProcThreadAttributeList(list);
      if(list!=IntPtr.Zero) Marshal.FreeHGlobal(list);
      if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if(jobs!=IntPtr.Zero) Marshal.FreeHGlobal(jobs);
      if(job!=IntPtr.Zero) CloseHandle(job);
      if(parent!=IntPtr.Zero) CloseHandle(parent);
    }
  }
}`;

export const WINDOWS_JOB_POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
try {
Add-Type -TypeDefinition @'
${WINDOWS_JOB_NATIVE_SOURCE}
'@
$config = [OmnesisProcessJob]::ReadConfiguration() | ConvertFrom-Json
$code = [OmnesisProcessJob]::Run([string]$config.command, [string[]]$config.args, [int]$config.parentPid)
exit $code
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}`;
