// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { windowsPowerShellExecutable } from "./windows-powershell.js";

const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const tsxWorkerApi = import.meta.resolve("tsx/esm/api");
const jobModule = new URL("./windows-job.ts", import.meta.url).href;
const fileModule = new URL("./windows-private-file.ts", import.meta.url).href;
let root: string;
let owned: { child: ChildProcess; closed: Promise<void> }[];
function run(
  program: string,
  localAppData = root,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", tsx, "--input-type=module", "-e", program], {
    env: { ...process.env, LOCALAPPDATA: localAppData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "",
    stderr = "";
  child.stdout!.on("data", (bytes: Buffer) => {
    stdout += bytes.toString("utf8");
  });
  child.stderr!.on("data", (bytes: Buffer) => {
    stderr += bytes.toString("utf8");
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  owned.push({ child, closed });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const program = `
import {runWindowsJob} from ${JSON.stringify(jobModule)};
const result=await runWindowsJob(process.execPath,['-e','process.stdout.write("fixture")'],{timeoutMs:15000});
process.stdout.write(JSON.stringify({...result,stdout:Buffer.from(result.stdout).toString('utf8')}));
if(result.exitCode!==0 || result.failure) process.exitCode=1;
`;
const bootstrapFixture = `
import {windowsWorkerInvocation} from ${JSON.stringify(new URL("./windows-worker-cache.ts", import.meta.url).href)};
import {runWindowsOwnedProcessSync} from ${JSON.stringify(new URL("./windows-owned-process.ts", import.meta.url).href)};
import {WINDOWS_JOB_POWERSHELL_SCRIPT} from ${JSON.stringify(new URL("./native/windows-job-source.ts", import.meta.url).href)};
import {windowsPowerShellExecutable} from ${JSON.stringify(new URL("./windows-powershell.ts", import.meta.url).href)};
const fixtureFrame=(value)=>{const bytes=Buffer.from(JSON.stringify(value)),length=Buffer.alloc(4);length.writeUInt32LE(bytes.length);return Buffer.concat([length,bytes]);};
function fixtureBootstrap(request) {
 return runWindowsOwnedProcessSync({command:windowsPowerShellExecutable(),args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(WINDOWS_JOB_POWERSHELL_SCRIPT,'utf16le').toString('base64')]},fixtureFrame({command:request.invocation.command,args:request.invocation.args,parentPid:process.pid}),{input:request.input,timeoutMs:15000,maxBuffer:65536});
}
let fixturePinKey;
windowsWorkerInvocation('job',request=>{
 const result=fixtureBootstrap(request);
 if(result.failure || result.exitCode!==0) throw Error('Fixture verification failed: '+result.stderr);
 fixturePinKey=JSON.parse(Buffer.from(result.stdout).toString('utf8')).pinKey;
 return result;
});
`;
const threadFixture = `
import {Worker} from 'node:worker_threads';
import {execFileSync} from 'node:child_process';
const threadCode=${JSON.stringify(`
const {parentPort,workerData}=require('node:worker_threads');
import(${JSON.stringify(tsxWorkerApi)}).then(({register})=>{
 register();return import(${JSON.stringify(jobModule)});
}).then(async({runWindowsJob})=>{
 if(workerData.importOnly) {parentPort.postMessage({imported:typeof runWindowsJob});parentPort.close();return;}
 const result=await runWindowsJob(process.execPath,['-e',''],{timeoutMs:15000});
 parentPort.postMessage({failure:result.failure,exitCode:result.exitCode});parentPort.close();
}).catch(error=>{parentPort.postMessage({error:String(error)});parentPort.close();});
`)};
async function fixtureThread(importOnly=false) {
 const worker=new Worker(threadCode,{eval:true,workerData:{importOnly},execArgv:[]});
 let result;
 await new Promise((resolve,reject)=>{worker.once('message',value=>result=value);worker.once('error',reject);worker.once('exit',code=>code===0?resolve():reject(Error('Fixture thread failed')));});
 await new Promise(resolve=>setImmediate(resolve));return result;
}
function fixtureHandleCount() {
 return Number(execFileSync(windowsPowerShellExecutable(),['-NoLogo','-NoProfile','-NonInteractive','-Command','[Console]::Out.Write(([Diagnostics.Process]::GetProcessById('+process.pid+')).HandleCount)'],{encoding:'utf8',windowsHide:true,timeout:10000}));
}
`;
function grantAncestor(rights: "Modify" | "AppendData") {
  const script = `$ErrorActionPreference='Stop';$acl=[IO.Directory]::GetAccessControl($env:OMNESIS_FIXTURE_FILE);$sid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0');$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]$env:OMNESIS_FIXTURE_RIGHTS,[Security.AccessControl.AccessControlType]::Allow);$acl.AddAccessRule($rule);[IO.Directory]::SetAccessControl($env:OMNESIS_FIXTURE_FILE,$acl)`;
  return spawnSync(
    windowsPowerShellExecutable(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, OMNESIS_FIXTURE_FILE: root, OMNESIS_FIXTURE_RIGHTS: rights },
      windowsHide: true,
      timeout: 15000,
    },
  );
}
function generation(): string {
  const cache = join(root, "Omnesis", "platform-native-v1");
  const names = readdirSync(cache);
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^[0-9a-f]{64}$/u);
  return join(cache, names[0]!);
}

it("registers the cache fixture's TypeScript module graph in parallel and replacement workers", () => {
  const script =
    threadFixture +
    `
const parallel=await Promise.all([fixtureThread(true),fixtureThread(true)]);
const churn=[];
for(let index=0;index<3;index++) churn.push(await fixtureThread(true));
process.stdout.write(JSON.stringify([...parallel,...churn]));
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(
    Array.from({ length: 5 }, () => ({ imported: "function" })),
  );
});

describe.skipIf(process.platform !== "win32")("Windows compiled worker cache", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "windows-native-cache-"));
    owned = [];
  });
  afterEach(async () => {
    for (const { child } of owned) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(owned.map(({ closed }) => closed));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  it("publishes one validated generation across simultaneous cold processes", async () => {
    const results = await Promise.all([run(program), run(program)]);
    for (const result of results) {
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ exitCode: 0, stdout: "fixture" });
    }
    const directory = generation();
    expect(readdirSync(directory).sort()).toEqual([
      "manifest.json",
      "worker.exe",
      "worker.exe.config",
    ]);
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as {
      sourceHash: string;
      binaryHash: string;
    };
    expect(directory.endsWith(manifest.sourceHash)).toBe(true);
    expect(manifest.binaryHash).toMatch(/^[0-9a-f]{64}$/u);
  });
  it("accepts DOS short-name cache ancestors on cold initialization and reuse", async () => {
    // GetShortPathName returns the original spelling on volumes without 8.3
    // aliases; on NTFS with aliases it exercises .NET's long-name expansion.
    const script = String.raw`$ErrorActionPreference='Stop';Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public static class FixtureShortPath {[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern uint GetShortPathName(string path,StringBuilder result,uint length);}';$result=[Text.StringBuilder]::new(32768);$length=[FixtureShortPath]::GetShortPathName($env:OMNESIS_FIXTURE_FILE,$result,32768);if($length -eq 0 -or $length -ge 32768){throw 'Short-path fixture failed'};[Console]::Out.Write($result.ToString())`;
    const alias = spawnSync(
      windowsPowerShellExecutable(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: { ...process.env, OMNESIS_FIXTURE_FILE: root },
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
      },
    );
    expect(alias.status, alias.stderr).toBe(0);
    expect(alias.stdout.length).toBeGreaterThan(0);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await run(program, alias.stdout);
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ exitCode: 0, stdout: "fixture" });
    }
    generation();
  });
  it("refuses a corrupt manifest before a valid cached worker can write", async () => {
    expect((await run(program)).code).toBe(0);
    const directory = generation();
    const path = join(directory, "manifest.json");
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...record, binaryHash: "0".repeat(64) }));
    const target = join(root, "unpublished.json");
    const result = await run(`
import {writeWindowsPrivateFileAtomic} from ${JSON.stringify(fileModule)};
try { await writeWindowsPrivateFileAtomic(${JSON.stringify(target)},Buffer.from('invented payload'));process.exitCode=2; }
catch(error) { process.stdout.write('refused'); }
`);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("refused");
    expect(existsSync(target)).toBe(false);
  });
  it("refuses a cached executable whose DACL permits another user to read it", async () => {
    expect((await run(program)).code).toBe(0);
    const executable = join(generation(), "worker.exe");
    const script = `$ErrorActionPreference='Stop';$acl=[IO.File]::GetAccessControl($env:OMNESIS_FIXTURE_FILE);$sid=[Security.Principal.SecurityIdentifier]::new('S-1-1-0');$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow);$acl.AddAccessRule($rule);[IO.File]::SetAccessControl($env:OMNESIS_FIXTURE_FILE,$acl)`;
    const changed = spawnSync(
      windowsPowerShellExecutable(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: { ...process.env, OMNESIS_FIXTURE_FILE: executable },
        windowsHide: true,
        timeout: 15000,
      },
    );
    expect(changed.status, changed.stderr?.toString()).toBe(0);
    const result = await run(program);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ failure: "spawn", exitCode: null });
  });
  it("refuses a cache generation replaced by a directory junction", async () => {
    expect((await run(program)).code).toBe(0);
    const directory = generation(),
      original = join(root, "owned-original");
    renameSync(directory, original);
    symlinkSync(original, directory, "junction");
    const result = await run(program);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ failure: "spawn", exitCode: null });
  });
  it("rejects an ancestor with another user's deletion and ACL-control rights", async () => {
    const changed = grantAncestor("Modify");
    expect(changed.status, changed.stderr?.toString()).toBe(0);
    const result = await run(program);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ failure: "spawn", exitCode: null });
    expect(existsSync(join(root, "Omnesis", "platform-native-v1"))).toBe(false);
  });
  it("allows harmless create-only rights on an existing ancestor", async () => {
    const changed = grantAncestor("AppendData");
    expect(changed.status, changed.stderr?.toString()).toBe(0);
    const result = await run(program);
    expect(result.code, result.stderr || result.stdout).toBe(0);
    generation();
  });
  it("rejects a junction in the cache's ancestor chain", async () => {
    const original = join(root, "profile"),
      alias = join(root, "alias");
    mkdirSync(original);
    symlinkSync(original, alias, "junction");
    const result = await run(program, alias);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ failure: "spawn", exitCode: null });
    expect(existsSync(join(original, "Omnesis", "platform-native-v1"))).toBe(false);
  });
  it("pins ancestors against redirection after verification while the owner remains alive", async () => {
    const profile = join(root, "profile");
    mkdirSync(profile);
    const result = await run(
      `
import {runWindowsJob} from ${JSON.stringify(jobModule)};
import {renameSync,mkdirSync,symlinkSync} from 'node:fs';
const profile=${JSON.stringify(profile)};
const first=await runWindowsJob(process.execPath,['-e',''],{timeoutMs:15000});
if(first.exitCode!==0 || first.failure) throw Error('Initial fixture failed');
let redirected=false;
try {renameSync(profile,profile+'-moved');mkdirSync(profile+'-shadow');symlinkSync(profile+'-shadow',profile,'junction');redirected=true;} catch(error) {if(error.code!=='EPERM' && error.code!=='EACCES' && error.code!=='EBUSY') throw error;}
const second=await runWindowsJob(process.execPath,['-e','process.stdout.write("still-owned")'],{timeoutMs:5000});
process.stdout.write(JSON.stringify({redirected,secondExitCode:second.exitCode,stdout:Buffer.from(second.stdout).toString('utf8')}));
`,
      profile,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      redirected: false,
      secondExitCode: 0,
      stdout: "still-owned",
    });
  });
  it("rejects an owner birth differing by one exact FILETIME tick without retaining pins", async () => {
    const profile = join(root, "profile");
    mkdirSync(profile);
    expect((await run(program, profile)).code).toBe(0);
    const result = await run(
      `
import {windowsWorkerInvocation} from ${JSON.stringify(new URL("./windows-worker-cache.ts", import.meta.url).href)};
import {runWindowsOwnedProcessSync} from ${JSON.stringify(new URL("./windows-owned-process.ts", import.meta.url).href)};
import {WINDOWS_JOB_POWERSHELL_SCRIPT} from ${JSON.stringify(new URL("./native/windows-job-source.ts", import.meta.url).href)};
import {windowsPowerShellExecutable} from ${JSON.stringify(new URL("./windows-powershell.ts", import.meta.url).href)};
import {renameSync} from 'node:fs';
const frame=(value)=>{const bytes=Buffer.from(JSON.stringify(value));const length=Buffer.alloc(4);length.writeUInt32LE(bytes.length);return Buffer.concat([length,bytes]);};
let refused=false;
try {windowsWorkerInvocation('job',(request)=>{
 const bytes=Buffer.from(request.input),programEnd=4+bytes.readUInt32LE(),metadataEnd=programEnd+4+bytes.readUInt32LE(programEnd);
 const metadata=JSON.parse(bytes.subarray(programEnd+4,metadataEnd).toString('utf8'));
 metadata.ownerBirth=(BigInt(metadata.ownerBirth)+1n).toString();
 const input=Buffer.concat([bytes.subarray(0,programEnd),frame(metadata),bytes.subarray(metadataEnd)]);
 return runWindowsOwnedProcessSync({command:windowsPowerShellExecutable(),args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(WINDOWS_JOB_POWERSHELL_SCRIPT,'utf16le').toString('base64')]},frame({command:request.invocation.command,args:request.invocation.args,parentPid:process.pid}),{input,timeoutMs:15000,maxBuffer:65536});
});} catch {refused=true;}
renameSync(${JSON.stringify(profile)},${JSON.stringify(profile + "-moved")});
process.stdout.write(JSON.stringify({refused}));
`,
      profile,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ refused: true });
  });
  it("reuses a bounded pin set across parallel worker initialization and worker churn", async () => {
    const result = await run(
      bootstrapFixture +
        threadFixture +
        `
const parallel=await Promise.all([fixtureThread(),fixtureThread()]);
const baseline=fixtureHandleCount(),counts=[];
const churn=[];
for(let index=0;index<3;index++) {churn.push(await fixtureThread());counts.push(fixtureHandleCount());}
process.stdout.write(JSON.stringify({parallel,churn,baseline,counts}));
`,
    );
    expect(result.code, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout) as {
      parallel: { exitCode: number; failure?: string }[];
      churn: { exitCode: number; failure?: string }[];
      baseline: number;
      counts: number[];
    };
    for (const item of [...evidence.parallel, ...evidence.churn])
      expect(item).toEqual({ exitCode: 0 });
    expect(Number.isFinite(evidence.baseline)).toBe(true);
    expect(evidence.counts).toHaveLength(3);
    expect(Math.max(...evidence.counts)).toBeLessThanOrEqual(evidence.baseline + 8);
  });
  it("refuses a stranded incomplete marker without adding another pin set", async () => {
    const result = await run(
      bootstrapFixture +
        threadFixture +
        `
execFileSync(windowsPowerShellExecutable(),['-NoLogo','-NoProfile','-NonInteractive','-Command',"$marker=[Threading.EventWaitHandle]::OpenExisting($env:OMNESIS_FIXTURE_PIN_KEY+'.ready');try{$null=$marker.Reset()}finally{$marker.Dispose()}"],{env:{...process.env,OMNESIS_FIXTURE_PIN_KEY:fixturePinKey},windowsHide:true,timeout:10000});
const baseline=fixtureHandleCount();
const failures=[];
for(let index=0;index<2;index++) failures.push(await fixtureThread());
process.stdout.write(JSON.stringify({baseline,after:fixtureHandleCount(),failures}));
`,
    );
    expect(result.code, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout) as {
      baseline: number;
      after: number;
      failures: { failure?: string; exitCode: number | null }[];
    };
    expect(evidence.failures).toEqual([
      { failure: "spawn", exitCode: null },
      { failure: "spawn", exitCode: null },
    ]);
    expect(evidence.after).toBeLessThanOrEqual(evidence.baseline + 8);
  });
  it("rejects a precreated kernel mutex with an untrusted DACL", async () => {
    const result = await run(
      bootstrapFixture +
        threadFixture +
        `
const {spawn}=await import('node:child_process');
const script="$ErrorActionPreference='Stop';$mutex=[Threading.Mutex]::new($false,$env:OMNESIS_FIXTURE_PIN_KEY+'.mutex');try{$acl=$mutex.GetAccessControl();$rule=[Security.AccessControl.MutexAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[Security.AccessControl.MutexRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow);$acl.AddAccessRule($rule);$mutex.SetAccessControl($acl);[Console]::Out.Write('ready');[Console]::In.ReadToEnd()|Out-Null}finally{$mutex.Dispose()}";
const poison=spawn(windowsPowerShellExecutable(),['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,OMNESIS_FIXTURE_PIN_KEY:fixturePinKey},windowsHide:true,stdio:['pipe','pipe','pipe']});
const closed=new Promise(resolve=>poison.once('close',resolve));
try {
 await new Promise((resolve,reject)=>{poison.once('error',reject);poison.stdout.once('data',bytes=>String(bytes)==='ready'?resolve():reject(Error('Fixture mutex unavailable')));poison.once('exit',()=>reject(Error('Fixture mutex exited')));});
 process.stdout.write(JSON.stringify(await fixtureThread()));
} finally {poison.stdin.end();await closed;}
`,
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ failure: "spawn", exitCode: null });
  });
  it("reports cold and warm filesystem latency with a verified cached worker", async () => {
    const target = join(root, "timing.json");
    const result = await run(`
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {writeWindowsPrivateFileAtomic,readWindowsPrivateFileContentsSync} from ${JSON.stringify(fileModule)};
const target=${JSON.stringify(target)},bytes=Buffer.from('invented benchmark payload');
let start=performance.now();await writeWindowsPrivateFileAtomic(target,bytes);const coldMs=performance.now()-start;
const warmSyncMs=[];
for(let index=0;index<8;index++) {start=performance.now();if(!readWindowsPrivateFileContentsSync(target).equals(bytes)) throw Error('Fixture mismatch');warmSyncMs.push(performance.now()-start);}
const delay=monitorEventLoopDelay({resolution:10});delay.enable();
start=performance.now();await writeWindowsPrivateFileAtomic(target,bytes);const warmAsyncMs=performance.now()-start;
await new Promise(resolve=>setTimeout(resolve,20));delay.disable();
process.stdout.write(JSON.stringify({coldMs,warmSyncMs,warmAsyncMs,maxAsyncEventLoopDelayMs:delay.max/1e6}));
`);
    expect(result.code, result.stderr).toBe(0);
    const timing = JSON.parse(result.stdout) as {
      coldMs: number;
      warmSyncMs: number[];
      warmAsyncMs: number;
      maxAsyncEventLoopDelayMs: number;
    };
    expect(timing.warmSyncMs).toHaveLength(8);
    expect(
      [
        timing.coldMs,
        ...timing.warmSyncMs,
        timing.warmAsyncMs,
        timing.maxAsyncEventLoopDelayMs,
      ].every(Number.isFinite),
    ).toBe(true);
    // Measurements, rather than an increased startup budget, guide the runtime
    // performance gate on the native host. This output contains no file data.
    process.stdout.write(JSON.stringify({ windowsNativeWorkerTiming: timing }) + "\n");
  });
});
