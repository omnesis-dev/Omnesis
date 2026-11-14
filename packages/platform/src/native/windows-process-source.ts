// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Process metadata and termination always refer to the same retained kernel object. */
export const WINDOWS_PROCESS_NATIVE_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class OmnesisProcessMetadata {
  const uint QUERY=0x400,SYNCHRONIZE=0x100000,TERMINATE=1,EXITED=0;
  const long FILETIME_EPOCH=504911232000000000L;
  const int MAX_PROCESSES=65536;
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct ProcessEntry {
    public uint size,usage,pid;public UIntPtr heap;public uint module,threads,parentPid;
    public int priority;public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string name;
  }
  [StructLayout(LayoutKind.Sequential)] struct BasicInformation {
    public int exitStatus;public IntPtr peb;public UIntPtr affinity;public int priority;
    public UIntPtr pid,parentPid;
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(SafeFileHandle snapshot,ref ProcessEntry entry);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(SafeFileHandle snapshot,ref ProcessEntry entry);
  [DllImport("kernel32.dll",SetLastError=true)] static extern SafeFileHandle OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(SafeFileHandle process,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(SafeFileHandle process,uint milliseconds);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(SafeFileHandle process,uint code);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(SafeFileHandle process,int kind,out BasicInformation information,int size,out int returned);
  [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);

  static SafeFileHandle Open(uint pid,uint access) {
    SafeFileHandle handle=OpenProcess(access|SYNCHRONIZE,false,pid);
    if(!handle.IsInvalid) return handle;
    int error=Marshal.GetLastWin32Error();handle.Dispose();
    if(error==87 || error==1168) return null;
    // Inaccessible candidate processes are uncertain, not evidence of exit.
    throw new Win32Exception(error);
  }
  static bool Exited(SafeFileHandle handle) {
    uint state=WaitForSingleObject(handle,0);
    if(state==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
    return state==EXITED;
  }
  static long Birth(SafeFileHandle handle) {
    long created,exited,kernel,user;
    if(!GetProcessTimes(handle,out created,out exited,out kernel,out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
    return checked(created+FILETIME_EPOCH);
  }
  static Dictionary<uint,List<uint>> Candidates() {
    Dictionary<uint,List<uint>> children=new Dictionary<uint,List<uint>>();
    using(SafeFileHandle snapshot=CreateToolhelp32Snapshot(2,0)) {
      if(snapshot.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      ProcessEntry entry=new ProcessEntry();entry.size=(uint)Marshal.SizeOf(typeof(ProcessEntry));
      bool next=Process32FirstW(snapshot,ref entry);int count=0;
      while(next) {
        if(++count>MAX_PROCESSES) throw new InvalidDataException();
        if(entry.pid!=0) {
          List<uint> values;
          if(!children.TryGetValue(entry.parentPid,out values)) {values=new List<uint>();children.Add(entry.parentPid,values);}
          values.Add(entry.pid);
        }
        next=Process32NextW(snapshot,ref entry);
      }
      int error=Marshal.GetLastWin32Error();if(error!=18) throw new Win32Exception(error);
    }
    return children;
  }
  sealed class Observation {
    public SafeFileHandle handle;
    public Dictionary<string,object> row;
  }
  public static void Snapshot(uint[] roots,Action<List<Dictionary<string,object>>> publish) {
    OmnesisPrivateFile.Stage="process-snapshot";
    Dictionary<uint,List<uint>> children=Candidates();
    Queue<uint> pending=new Queue<uint>(roots);HashSet<uint> seen=new HashSet<uint>();
    List<SafeFileHandle> handles=new List<SafeFileHandle>();
    List<Observation> observed=new List<Observation>();
    try {
      while(pending.Count!=0) {
        uint pid=pending.Dequeue();if(!seen.Add(pid)) continue;
        if(seen.Count>MAX_PROCESSES) throw new InvalidDataException();
        List<uint> descendants;if(children.TryGetValue(pid,out descendants)) foreach(uint child in descendants) pending.Enqueue(child);
        SafeFileHandle handle=Open(pid,QUERY);if(handle==null) continue;
        handles.Add(handle);
        if(Exited(handle)) continue;
        long birth=Birth(handle);BasicInformation info;int returned;
        // Toolhelp only selects candidates. Its PPID is never paired with a
        // later PID's birth: query both fields on this same pinned object.
        int status=NtQueryInformationProcess(handle,0,out info,Marshal.SizeOf(typeof(BasicInformation)),out returned);
        if(status<0) {if(Exited(handle)) continue;throw new Win32Exception((int)RtlNtStatusToDosError(status));}
        if(info.pid.ToUInt64()!=pid || info.parentPid.ToUInt64()>UInt32.MaxValue || returned!=Marshal.SizeOf(typeof(BasicInformation))) throw new InvalidDataException();
        Dictionary<string,object> row=new Dictionary<string,object>();row["pid"]=pid;row["parentPid"]=(uint)info.parentPid.ToUInt64();row["birth"]=birth.ToString(CultureInfo.InvariantCulture);
        observed.Add(new Observation {handle=handle,row=row});
      }
      // Keep every observed parent object pinned until all child metadata is
      // captured: Windows cannot recycle those PIDs between rows. Filter dead
      // parents only after capture, so unknown children cannot inherit stale
      // ownership; callers may still retain previously known orphan births.
      List<Dictionary<string,object>> rows=new List<Dictionary<string,object>>();
      foreach(Observation observation in observed) if(!Exited(observation.handle)) rows.Add(observation.row);
      publish(rows);
    } finally {
      foreach(SafeFileHandle handle in handles) handle.Dispose();
    }
  }
  public static void Kill(uint[] pids,long[] births) {
    OmnesisPrivateFile.Stage="process-kill";
    for(int index=0;index<pids.Length;index++) {
      using(SafeFileHandle handle=Open(pids[index],QUERY|TERMINATE)) {
        if(handle==null || Exited(handle) || Birth(handle)!=births[index]) continue;
        // The numeric ID is no longer consulted after OpenProcess succeeds.
        if(!TerminateProcess(handle,1)) {if(Exited(handle)) continue;throw new Win32Exception(Marshal.GetLastWin32Error());}
        uint wait=WaitForSingleObject(handle,5000);
        if(wait==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
        if(wait!=EXITED) throw new InvalidOperationException("Owned process did not exit");
      }
    }
  }
}
`;
