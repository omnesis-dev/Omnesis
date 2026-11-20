// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { expect, it } from "vitest";
import { WINDOWS_PROCESS_NATIVE_SOURCE } from "./native/windows-process-source.js";
import { runWindowsJob } from "./windows-job.js";
import { windowsPowerShellExecutable } from "./windows-powershell.js";
import {
  killWindowsProcesses,
  snapshotWindowsProcesses,
  snapshotWindowsProcessesSync,
} from "./windows-process.js";

it.runIf(process.platform === "win32")(
  "pins exact native births, refuses a one-tick mismatch, and releases an owned listening socket",
  async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const server = require('node:net').createServer(); server.listen(0, '127.0.0.1', () => process.send(server.address().port));`,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true },
    );
    const exited = once(child, "exit");
    try {
      const [port] = (await once(child, "message")) as [number];
      const rows = await snapshotWindowsProcesses([child.pid!]);
      const identity = rows.find((row) => row.pid === child.pid)!;
      expect(identity).toEqual({
        pid: child.pid,
        parentPid: process.pid,
        birth: expect.stringMatching(/^\d+$/u),
      });
      expect(Object.keys(identity).sort()).toEqual(["birth", "parentPid", "pid"]);
      expect(snapshotWindowsProcessesSync([child.pid!])).toContainEqual(identity);
      await killWindowsProcesses([
        { pid: identity.pid, birth: String(BigInt(identity.birth) + 1n) },
      ]);
      expect(child.exitCode).toBeNull();
      expect(await snapshotWindowsProcesses([child.pid!])).toContainEqual(identity);
      await killWindowsProcesses([identity]);
      await exited;
      expect(await snapshotWindowsProcesses([identity.pid])).toEqual([]);
      const socket = createServer();
      try {
        socket.listen(port, "127.0.0.1");
        await once(socket, "listening");
      } finally {
        await new Promise<void>((resolve, reject) =>
          socket.close((error) => (error ? reject(error) : resolve())),
        );
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  },
  60_000,
);

// Substitute only kernel observations in a compiled fixture. The capture loop,
// final live filtering, publication and finally-disposal are production source.
function snapshotLifetimeFixture(): string {
  const declarations = WINDOWS_PROCESS_NATIVE_SOURCE.slice(
    0,
    WINDOWS_PROCESS_NATIVE_SOURCE.indexOf("  [DllImport("),
  );
  const capture = WINDOWS_PROCESS_NATIVE_SOURCE.slice(
    WINDOWS_PROCESS_NATIVE_SOURCE.indexOf("  sealed class Observation {"),
    WINDOWS_PROCESS_NATIVE_SOURCE.indexOf("  public static void Kill("),
  );
  return (
    declarations +
    String.raw`
  static Dictionary<uint,SafeFileHandle> held=new Dictionary<uint,SafeFileHandle>();
  static bool parentExited,failCapture;
  // 102 is listed under 100 but is older than it: an earlier holder of that
  // PID created it. 104 is gone, so its listed child 105 cannot be adopted.
  static Dictionary<uint,List<Candidate>> Candidates() {
    return new Dictionary<uint,List<Candidate>> {
      {100,new List<Candidate>{listed(101),listed(102)}},
      {104,new List<Candidate>{listed(105)}},
    };
  }
  static Candidate listed(uint pid) {
    return new Candidate {pid=pid,created=638999999999999000L+(pid==102 ? 99 : pid)-FILETIME_EPOCH};
  }
  static SafeFileHandle Open(uint pid,uint access) {
    if(pid==102 || pid==105) throw new Exception("non-descendant candidate opened");
    if(pid==104) return null;
    if(pid==101 && held[100].IsClosed) throw new Exception("parent pin released during capture");
    SafeFileHandle handle=new SafeFileHandle(new IntPtr(pid),false);held.Add(pid,handle);return handle;
  }
  static bool Exited(SafeFileHandle handle) {return parentExited && handle.DangerousGetHandle().ToInt64()==100;}
  static long Birth(SafeFileHandle handle) {return 638999999999999000L+handle.DangerousGetHandle().ToInt64();}
  static int NtQueryInformationProcess(SafeFileHandle handle,int kind,out BasicInformation info,int size,out int returned) {
    uint pid=(uint)handle.DangerousGetHandle().ToInt64();
    if(pid==101) {
      if(held[100].IsClosed) throw new Exception("parent pin released before child metadata");
      parentExited=true;
      if(failCapture) throw new Exception("capture failure");
    }
    info=new BasicInformation();info.pid=new UIntPtr(pid);info.parentPid=new UIntPtr(pid==101?100u:1u);
    returned=Marshal.SizeOf(typeof(BasicInformation));return 0;
  }
  static uint RtlNtStatusToDosError(int status) {return 1;}
  public static string Exercise(int mode) {
    held.Clear();parentExited=false;failCapture=mode==1;bool failed=false;
    try {
      Snapshot(new uint[]{100,104},delegate(List<Dictionary<string,object>> rows) {
        if(held[100].IsClosed || held[101].IsClosed) throw new Exception("pin released before publication");
        if(rows.Count!=1 || (uint)rows[0]["pid"]!=101) throw new Exception("exited parent was published");
        if(mode==2) throw new Exception("publication failure");
      });
    } catch(Exception error) {
      if((mode==1 && error.Message=="capture failure") || (mode==2 && error.Message=="publication failure")) failed=true;
      else throw;
    }
    if(mode!=0 && !failed) throw new Exception("expected failure was swallowed");
    foreach(SafeFileHandle handle in held.Values) if(!handle.IsClosed) throw new Exception("retained handle leaked");
    return "closed:"+mode;
  }
` +
    capture +
    "\n}\npublic static class OmnesisPrivateFile {public static string Stage;}"
  );
}

it.runIf(process.platform === "win32")(
  "retains the whole capture until publication, filters exited parents, opens no older or orphaned candidate, and closes every handle on capture/publication failures",
  async () => {
    const result = await runWindowsJob(
      windowsPowerShellExecutable(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; $source=[Console]::In.ReadToEnd(); Add-Type -TypeDefinition $source; [Console]::Out.Write([OmnesisProcessMetadata]::Exercise(0)+'|'+[OmnesisProcessMetadata]::Exercise(1)+'|'+[OmnesisProcessMetadata]::Exercise(2))",
      ],
      { input: Buffer.from(snapshotLifetimeFixture()), timeoutMs: 60_000 },
    );
    expect(result.failure).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout).toString("utf8")).toBe("closed:0|closed:1|closed:2");
  },
  60_000,
);

/** Reuse the production capture/helpers; substitute only the failing kernel calls. */
function failurePhaseFixture(): string {
  const declarations = WINDOWS_PROCESS_NATIVE_SOURCE.slice(
    0,
    WINDOWS_PROCESS_NATIVE_SOURCE.indexOf("  [DllImport("),
  );
  const helpers = WINDOWS_PROCESS_NATIVE_SOURCE.slice(
    WINDOWS_PROCESS_NATIVE_SOURCE.indexOf("  static SafeFileHandle Open("),
    WINDOWS_PROCESS_NATIVE_SOURCE.indexOf("  static Dictionary<uint,List<Candidate>> Candidates("),
  );
  const capture = WINDOWS_PROCESS_NATIVE_SOURCE.slice(
    WINDOWS_PROCESS_NATIVE_SOURCE.indexOf("  sealed class Observation {"),
    WINDOWS_PROCESS_NATIVE_SOURCE.indexOf("  public static void Kill("),
  );
  return (
    declarations +
    String.raw`
  static int mode;
  [DllImport("kernel32.dll",EntryPoint="SetLastError",SetLastError=true)] static extern void SetNativeError(uint error);
  static SafeFileHandle OpenProcess(uint access,bool inherit,uint pid) {
    SetNativeError(5);return new SafeFileHandle(mode==0 ? IntPtr.Zero : new IntPtr(100),false);
  }
  static uint WaitForSingleObject(SafeFileHandle handle,uint milliseconds) {
    if(mode==1) {SetNativeError(5);return 0xffffffff;}return 258;
  }
  static bool GetProcessTimes(SafeFileHandle handle,out long created,out long exited,out long kernel,out long user) {
    created=1;exited=kernel=user=0;if(mode==2) {SetNativeError(5);return false;}return true;
  }
  static int NtQueryInformationProcess(SafeFileHandle handle,int kind,out BasicInformation info,int size,out int returned) {
    info=new BasicInformation();info.pid=new UIntPtr(100u);info.parentPid=new UIntPtr(1u);
    returned=Marshal.SizeOf(typeof(BasicInformation));return mode==3 ? unchecked((int)0xC000010A) : 0;
  }
  static uint RtlNtStatusToDosError(int status) {return 5;}
  static Dictionary<uint,List<Candidate>> Candidates() {return new Dictionary<uint,List<Candidate>>();}
  public static string Exercise() {
    List<string> errors=new List<string>();
    for(mode=0;mode<4;mode++) {
      try {Snapshot(new uint[]{100},delegate(List<Dictionary<string,object>> rows) {});throw new Exception("Expected native refusal");}
      catch(Win32Exception error) {errors.Add(OmnesisPrivateFile.Stage+":"+error.NativeErrorCode.ToString(CultureInfo.InvariantCulture));}
    }
    return String.Join("|",errors.ToArray());
  }
` +
    helpers +
    capture +
    "\n}\npublic static class OmnesisPrivateFile {public static string Stage;}"
  );
}

it.runIf(process.platform === "win32")(
  "identifies native refusal phases without weakening failures or exposing process metadata",
  async () => {
    const result = await runWindowsJob(
      windowsPowerShellExecutable(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; $source=[Console]::In.ReadToEnd(); Add-Type -TypeDefinition $source; [Console]::Out.Write([OmnesisProcessMetadata]::Exercise())",
      ],
      { input: Buffer.from(failurePhaseFixture()), timeoutMs: 60_000 },
    );
    expect(result.failure).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stdout).toString("utf8")).toBe(
      "process-snapshot-open:5|process-snapshot-wait:5|process-snapshot-birth:5|process-snapshot-query-C000010A:5",
    );
  },
  60_000,
);

// Each session's csrss.exe records as its creator a session manager
// instance that exited during boot, so its recorded parent PID is either free
// or held by a younger process. Normal callers cannot query csrss.exe with
// full rights. A snapshot rooted at that recorded PID, as happens when an
// owned process receives the number, must neither open nor adopt it.
it.runIf(process.platform === "win32")(
  "opens no older process recorded under a root's reused PID",
  async () => {
    const listing = await runWindowsJob(
      windowsPowerShellExecutable(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name='csrss.exe'\" | ForEach-Object { @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId} })",
      ],
      { timeoutMs: 60_000 },
    );
    expect(listing.failure).toBeUndefined();
    expect(listing.exitCode).toBe(0);
    const sessions = JSON.parse(Buffer.from(listing.stdout).toString("utf8")) as {
      pid: number;
      parentPid: number;
    }[];
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      const rows = await snapshotWindowsProcesses([session.parentPid]);
      expect(rows.some((row) => row.pid === session.pid)).toBe(false);
    }
  },
  120_000,
);
