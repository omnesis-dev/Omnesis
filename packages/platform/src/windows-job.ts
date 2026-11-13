// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import { windowsPowerShellExecutable } from "./windows-powershell.js";

export interface WindowsJobOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Uint8Array;
  /** Forward raw input after the configuration frame; the target receives a pipe. */
  inputStream?: Readable;
  timeoutMs?: number;
  signal?: AbortSignal;
  captureStdout?: boolean;
  stdout?: "capture" | "inherit" | "ignore";
  onStderr?: (bytes: Uint8Array) => void;
}

export interface WindowsJobResult {
  exitCode: number | null;
  signal: string | null;
  stdout: Uint8Array;
  stderr: string;
  failure?: "spawn" | "timeout" | "aborted";
  failureMessage?: string;
}

const STDERR_LIMIT = 4_000;
const helpers = new Map<number, ChildProcess>();

/** Stop the job owner: Windows closes its job handle and terminates every member. */
export function killWindowsJob(pid: number): void {
  const helper = helpers.get(pid);
  if (helper) helper.kill("SIGKILL");
  // Another process's helper watches its pinned parent handle. An unknown
  // numeric PID is never enough evidence to terminate a process here.
}

/**
 * A job owns the target before its first instruction, including descendants
 * whose parent exits before a process-table snapshot could observe them.
 * Binary standard handles go directly to the target. The helper consumes only
 * a length-prefixed UTF-8 configuration using exact-length native reads.
 */
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
using System.Text;

public static class OmnesisProcessJob {
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
}
'@
$config = [OmnesisProcessJob]::ReadConfiguration() | ConvertFrom-Json
$code = [OmnesisProcessJob]::Run([string]$config.command, [string[]]$config.args, [int]$config.parentPid)
exit $code
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

export function windowsJobInvocation(): { command: string; args: string[] } {
  return {
    // The target's cwd/PATH may be untrusted; never discover the helper there.
    command: windowsPowerShellExecutable(),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(SCRIPT, "utf16le").toString("base64"),
    ],
  };
}

/** The helper stays alive until all job members exit; kill stops the whole job. */
export type WindowsJobProcess = ChildProcessWithoutNullStreams & { jobReady: Promise<void> };
type JobProcess = ChildProcess & { jobReady: Promise<void> };
type SpawnOptions = Pick<WindowsJobOptions, "cwd" | "env" | "stdout" | "captureStdout">;

/**
 * Start an owned binary stream. The configuration is queued before returning,
 * so subsequent stdin writes are literal target input. Await jobReady to detect
 * native creation failures; the helper's exit code remains the target's code.
 */
export function spawnWindowsJob(
  command: string,
  args: readonly string[],
  opts: Pick<WindowsJobOptions, "cwd" | "env"> = {},
): WindowsJobProcess {
  // This configuration always creates three pipes.
  return createWindowsJob(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "capture",
  }) as WindowsJobProcess;
}

function createWindowsJob(
  command: string,
  args: readonly string[],
  opts: SpawnOptions,
  onSpawn?: (pid: number) => void,
): JobProcess {
  if ([command, ...args].some((value) => value.includes("\0"))) {
    throw new Error("Program and arguments must not contain null bytes");
  }
  const payload = Buffer.from(JSON.stringify({ command, args, parentPid: process.pid }), "utf8");
  if (payload.length > 262144) {
    throw new Error("Process configuration is too large (ENAMETOOLONG)");
  }
  const invocation = windowsJobInvocation();
  const output = opts.stdout ?? (opts.captureStdout === false ? "ignore" : "capture");
  const child = spawn(invocation.command, invocation.args, {
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: true,
    stdio: ["pipe", output === "capture" ? "pipe" : output, "pipe"],
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const jobReady = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A consumer may rely on exit alone; readiness must never reject unobserved.
  void jobReady.catch(() => {});
  const proc: JobProcess = Object.assign(child, { jobReady });
  const rawStderr = proc.stderr!;
  const stderr = new PassThrough();
  proc.stderr = stderr;
  proc.stdio[2] = stderr;
  let prefix = Buffer.alloc(0);
  let statusRead = false;
  rawStderr.on("data", (chunk: Buffer) => {
    if (statusRead) {
      if (!stderr.write(chunk)) rawStderr.pause();
      return;
    }
    prefix = Buffer.concat([prefix, chunk]);
    const end = prefix.indexOf(10);
    if (end < 0 && prefix.length < STDERR_LIMIT) return;
    statusRead = true;
    const first = prefix
      .subarray(0, end < 0 ? prefix.length : end)
      .toString("utf8")
      .replace(/\r$/u, "");
    const match = /^OMNESIS_JOB:(\d+)$/u.exec(first);
    if (match) {
      const code = Number(match[1]);
      if (code === 0) resolveReady();
      else {
        const name =
          code === 2 || code === 3
            ? "ENOENT"
            : code === 5
              ? "EACCES"
              : code === 193
                ? "ENOEXEC"
                : `Windows error ${code}`;
        rejectReady(
          Object.assign(new Error(`Cannot start program (${name}, Windows error ${code})`), {
            code: name,
          }),
        );
      }
      if (end >= 0 && !stderr.write(prefix.subarray(end + 1))) rawStderr.pause();
    } else {
      rejectReady(new Error(first || "Invalid Windows process helper status"));
      stderr.write(prefix);
      proc.kill("SIGKILL");
    }
    prefix = Buffer.alloc(0);
  });
  stderr.on("drain", () => rawStderr.resume());
  rawStderr.once("end", () => {
    if (!statusRead) {
      rejectReady(
        new Error(
          prefix.toString("utf8") || "Windows process helper exited before starting the program",
        ),
      );
      stderr.end(prefix);
    } else stderr.end();
  });
  rawStderr.once("error", (error) => rejectReady(error));
  proc.once("error", (error) => rejectReady(error));
  proc.once("close", () => {
    rejectReady(new Error("Windows process helper exited before starting the program"));
    if (proc.pid !== undefined && helpers.get(proc.pid) === proc) helpers.delete(proc.pid);
  });
  proc.stdin!.on("error", () => {});
  if (proc.pid !== undefined) {
    helpers.set(proc.pid, proc);
    try {
      onSpawn?.(proc.pid);
    } catch (error) {
      rejectReady(error);
      proc.kill("SIGKILL");
      return proc;
    }
  }
  const length = Buffer.alloc(4);
  length.writeUInt32LE(payload.length);
  proc.stdin!.write(Buffer.concat([length, payload]));
  return proc;
}

/** Run an owned job through completion, publishing its PID before target start. */
export function runWindowsJob(
  command: string,
  args: readonly string[],
  opts: WindowsJobOptions,
  onSpawn?: (pid: number) => void,
): Promise<WindowsJobResult> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    let stderr = "";
    let ready = false;
    let failure: WindowsJobResult["failure"];
    let failureMessage: string | undefined;
    let finished = false;
    let publicationError: unknown;
    let publicationFailed = false;
    let proc: JobProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number | null, signal: string | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (proc?.stdin && opts.inputStream) opts.inputStream.unpipe(proc.stdin);
      if (publicationFailed) {
        reject(publicationError);
        return;
      }
      if (!ready && !failure) {
        failure = "spawn";
        failureMessage = stderr || "Windows process helper exited before starting the program";
      }
      resolve({
        exitCode: failure ? null : code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr,
        ...(failure ? { failure } : {}),
        ...(failureMessage ? { failureMessage } : {}),
      });
    };
    const stop = (reason: "timeout" | "aborted"): void => {
      failure ??= reason;
      proc?.kill("SIGKILL");
    };
    const onAbort = (): void => stop("aborted");
    if (opts.timeoutMs !== undefined) timer = setTimeout(() => stop("timeout"), opts.timeoutMs);
    if (opts.signal?.aborted) {
      failure = "aborted";
      finish(null, null);
      return;
    }
    if (opts.input !== undefined && opts.inputStream !== undefined) {
      failure = "spawn";
      failureMessage = "Provide binary input or an input stream, not both";
      finish(null, null);
      return;
    }
    try {
      proc = createWindowsJob(command, args, opts, (pid) => {
        try {
          onSpawn?.(pid);
        } catch (error) {
          publicationFailed = true;
          publicationError = error;
          throw error;
        }
      });
    } catch (error) {
      failure = "spawn";
      failureMessage = error instanceof Error ? error.message : String(error);
      finish(null, null);
      return;
    }
    void proc.jobReady.then(
      () => {
        ready = true;
      },
      (error: unknown) => {
        failure ??= "spawn";
        failureMessage = error instanceof Error ? error.message : String(error);
      },
    );
    proc.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr?.on("data", (bytes: Buffer) => {
      stderr += bytes.toString("utf8").slice(0, STDERR_LIMIT - stderr.length);
      opts.onStderr?.(bytes);
    });
    proc.on("error", (error) => {
      failure ??= "spawn";
      failureMessage = error.message;
    });
    proc.on("close", (code, signal) => finish(code, signal));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) {
      stop("aborted");
      return;
    }
    if (publicationFailed) return;
    if (opts.inputStream) opts.inputStream.pipe(proc.stdin!);
    else proc.stdin!.end(opts.input);
  });
}

/** Synchronous callers retain the same kernel containment and binary framing. */
export function runWindowsJobSync(
  command: string,
  args: readonly string[],
  opts: Pick<
    WindowsJobOptions,
    "cwd" | "env" | "input" | "timeoutMs" | "stdout" | "captureStdout"
  > & { maxBuffer?: number } = {},
): WindowsJobResult {
  if ([command, ...args].some((value) => value.includes("\0"))) {
    return {
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: "",
      failure: "spawn",
      failureMessage: "Program and arguments must not contain null bytes",
    };
  }
  const payload = Buffer.from(JSON.stringify({ command, args, parentPid: process.pid }), "utf8");
  if (payload.length > 262144) {
    return {
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: "",
      failure: "spawn",
      failureMessage: "Process configuration is too large (ENAMETOOLONG)",
    };
  }
  const length = Buffer.alloc(4);
  length.writeUInt32LE(payload.length);
  const invocation = windowsJobInvocation();
  const output = opts.stdout ?? (opts.captureStdout === false ? "ignore" : "capture");
  const run = spawnSync(invocation.command, invocation.args, {
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: true,
    input: Buffer.concat([length, payload, Buffer.from(opts.input ?? [])]),
    stdio: ["pipe", output === "capture" ? "pipe" : output, "pipe"],
    timeout: opts.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
  });
  const raw = run.stderr?.toString("utf8") ?? "";
  const end = raw.indexOf("\n");
  const match = /^OMNESIS_JOB:(\d+)\r?$/u.exec(raw.slice(0, end < 0 ? raw.length : end));
  const nativeCode = match ? Number(match[1]) : undefined;
  const stderr = match && end >= 0 ? raw.slice(end + 1) : raw;
  let failure: WindowsJobResult["failure"];
  let failureMessage: string | undefined;
  if (run.error) {
    failure = "code" in run.error && run.error.code === "ETIMEDOUT" ? "timeout" : "spawn";
    failureMessage = run.error.message;
  } else if (nativeCode !== 0) {
    failure = "spawn";
    const name =
      nativeCode === 2 || nativeCode === 3
        ? "ENOENT"
        : nativeCode === 5
          ? "EACCES"
          : nativeCode === 193
            ? "ENOEXEC"
            : `Windows error ${nativeCode ?? "unknown"}`;
    failureMessage = match
      ? `Cannot start program (${name})`
      : stderr || "Windows process helper exited before starting the program";
  }
  return {
    exitCode: failure ? null : run.status,
    signal: run.signal,
    stdout: run.stdout ?? Buffer.alloc(0),
    stderr,
    ...(failure ? { failure } : {}),
    ...(failureMessage ? { failureMessage } : {}),
  };
}
