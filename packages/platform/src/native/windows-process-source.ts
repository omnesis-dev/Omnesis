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
  const uint QUERY=0x1000,SYNCHRONIZE=0x100000,TERMINATE=1,EXITED=0;
  const long FILETIME_EPOCH=504911232000000000L;
  const int MAX_PROCESSES=65536,MAX_LISTING_BYTES=64<<20,LENGTH_MISMATCH=unchecked((int)0xC0000004);
  [StructLayout(LayoutKind.Sequential)] struct SystemProcess {
    public uint next,threads;public long workingSetPrivate;public uint hardFaults,threadsHighWatermark;public ulong cycles;
    public long created,user,kernel;public ushort nameLength,nameMaximum;public IntPtr name;public int priority;
    public IntPtr pid,parentPid;
  }
  struct Candidate {public uint pid;public long created;}
  [StructLayout(LayoutKind.Sequential)] struct BasicInformation {
    public int exitStatus;public IntPtr peb;public UIntPtr affinity;public int priority;
    public UIntPtr pid,parentPid;
  }
  // See #1143 — distinguish native refusals without exposing process metadata.
  static Win32Exception Failure(string phase,int error) {
    OmnesisPrivateFile.Stage+="-"+phase;
    return new Win32Exception(error);
  }
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int kind,IntPtr buffer,int size,out int returned);
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
    throw Failure("open",error);
  }
  static bool Exited(SafeFileHandle handle) {
    uint state=WaitForSingleObject(handle,0);
    if(state==0xffffffff) throw Failure("wait",Marshal.GetLastWin32Error());
    return state==EXITED;
  }
  static long Birth(SafeFileHandle handle) {
    long created,exited,kernel,user;
    if(!GetProcessTimes(handle,out created,out exited,out kernel,out user)) throw Failure("birth",Marshal.GetLastWin32Error());
    return checked(created+FILETIME_EPOCH);
  }
  // The system listing records each process's creator PID and creation time
  // without opening it. A recorded creator PID can name an earlier holder of
  // that number, so the listing only proposes candidates (see #1143).
  static Dictionary<uint,List<Candidate>> Candidates() {
    for(int size=1<<20;;) {
      IntPtr buffer=Marshal.AllocHGlobal(size);
      try {
        int returned;int status=NtQuerySystemInformation(5,buffer,size,out returned);
        if(status==LENGTH_MISMATCH && size<MAX_LISTING_BYTES) {size=Math.Min(MAX_LISTING_BYTES,Math.Max(size*2,returned+(1<<16)));continue;}
        if(status<0) throw Failure("enumerate",(int)RtlNtStatusToDosError(status));
        Dictionary<uint,List<Candidate>> children=new Dictionary<uint,List<Candidate>>();
        int entrySize=Marshal.SizeOf(typeof(SystemProcess));
        for(long offset=0,count=0;;) {
          if(++count>MAX_PROCESSES || offset<0 || offset+entrySize>returned) throw new InvalidDataException();
          SystemProcess entry=(SystemProcess)Marshal.PtrToStructure(new IntPtr(buffer.ToInt64()+offset),typeof(SystemProcess));
          long pid=entry.pid.ToInt64(),parentPid=entry.parentPid.ToInt64();
          if(pid<0 || pid>UInt32.MaxValue || parentPid<0 || parentPid>UInt32.MaxValue) throw new InvalidDataException();
          if(pid!=0) {
            List<Candidate> values;
            if(!children.TryGetValue((uint)parentPid,out values)) {values=new List<Candidate>();children.Add((uint)parentPid,values);}
            values.Add(new Candidate {pid=(uint)pid,created=entry.created});
          }
          if(entry.next==0) break;
          offset+=entry.next;
        }
        return children;
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }
  }
  sealed class Observation {
    public SafeFileHandle handle;
    public Dictionary<string,object> row;
  }
  public static void Snapshot(uint[] roots,Action<List<Dictionary<string,object>>> publish) {
    OmnesisPrivateFile.Stage="process-snapshot";
    Dictionary<uint,List<Candidate>> children=Candidates();
    Queue<uint> pending=new Queue<uint>(roots);HashSet<uint> seen=new HashSet<uint>();
    List<SafeFileHandle> handles=new List<SafeFileHandle>();
    List<Observation> observed=new List<Observation>();
    try {
      while(pending.Count!=0) {
        uint pid=pending.Dequeue();if(!seen.Add(pid)) continue;
        if(seen.Count>MAX_PROCESSES) throw new InvalidDataException();
        SafeFileHandle handle=Open(pid,QUERY);if(handle==null) continue;
        handles.Add(handle);
        if(Exited(handle)) continue;
        long birth=Birth(handle);BasicInformation info;int returned;
        // The listing only selects candidates. Its PPID is never paired with a
        // later PID's birth: query both fields on this same pinned object.
        int status=NtQueryInformationProcess(handle,0,out info,Marshal.SizeOf(typeof(BasicInformation)),out returned);
        if(status<0) {if(Exited(handle)) continue;throw Failure("query-"+unchecked((uint)status).ToString("X8",CultureInfo.InvariantCulture),(int)RtlNtStatusToDosError(status));}
        if(info.pid.ToUInt64()!=pid || info.parentPid.ToUInt64()>UInt32.MaxValue || returned!=Marshal.SizeOf(typeof(BasicInformation))) throw new InvalidDataException();
        Dictionary<string,object> row=new Dictionary<string,object>();row["pid"]=pid;row["parentPid"]=(uint)info.parentPid.ToUInt64();row["birth"]=birth.ToString(CultureInfo.InvariantCulture);
        observed.Add(new Observation {handle=handle,row=row});
        // Descend only from a live parent pinned here, and only to processes
        // created no earlier than it: an older process listed under this PID
        // was created by a previous holder of the number. Children of a parent
        // that has gone cannot be adopted by their caller, so none are opened.
        List<Candidate> descendants;
        if(children.TryGetValue(pid,out descendants)) foreach(Candidate child in descendants) if(checked(child.created+FILETIME_EPOCH)>=birth) pending.Enqueue(child.pid);
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
