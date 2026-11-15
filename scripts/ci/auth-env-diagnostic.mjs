// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execWindowsJob } from "../../packages/core/src/windows-job-exec.ts";
import { authSubprocessEnvironment } from "../../packages/collector/src/auth-subprocess-env.ts";
import { win32 } from "node:path";

if (process.platform !== "win32") throw new Error("Windows diagnostic only");
const base = authSubprocessEnvironment("invented-config", process.env);
const variants = [
  ["curated", []],
  ["curated-dotnet", [], true],
  ["program-files", ["ProgramFiles"]],
  ["module-path", ["PSModulePath"]],
  ["both", ["ProgramFiles", "PSModulePath"]],
  ["program-directories", ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]],
  ["full-control", null],
  ["curated-addtype", [], true, "compile"],
  ["builtin-modules-addtype", [], true, "builtin"],
  ["explicit-utility-addtype", [], true, "utility"],
];
const program = String.raw`
const {spawnSync}=require('node:child_process');
const {join}=require('node:path');
const keys=['SystemRoot','LOCALAPPDATA','USERPROFILE','ProgramFiles','PSModulePath','TEMP'];
const present=Object.fromEntries(keys.map(key=>[key,Boolean(process.env[key])]));
const exe=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const expression=process.env.OMNESIS_AUTH_FIXTURE_DOTNET
  ? "([System.Diagnostics.Process]::GetProcessById("+process.pid+"))"
  : "(Get-Process -Id "+process.pid+")";
const prefix=process.env.OMNESIS_AUTH_FIXTURE_UTILITY
  ? "Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop;"
  : '';
const compile=process.env.OMNESIS_AUTH_FIXTURE_COMPILE
  ? "Add-Type -TypeDefinition 'public static class InventedModuleProbe { public static int Value { get { return 1; } } }';if ([InventedModuleProbe]::Value -ne 1) { throw 'Compiler probe failed' };"
  : '';
const result=spawnSync(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command',
  "$ErrorActionPreference='Stop';"+prefix+compile+"[Console]::Out.Write("+expression+".StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture))"],
  {encoding:'utf8',timeout:10000,windowsHide:true});
process.stdout.write(JSON.stringify({present,status:result.status,error:result.error?.code,
  numericTicks:/^[0-9]+$/.test(result.stdout?.trim()??''),stderr:result.stderr?.slice(0,4000)}));
`;
const launcher = `import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e',${JSON.stringify(program)}],{env:JSON.parse(process.env.OMNESIS_AUTH_FIXTURE_ENV),stdio:['ignore','inherit','inherit']});child.once('error',()=>{process.exitCode=1;});child.once('exit',code=>{process.exitCode=code??1;});`;
for (const [label, extra, direct, compile] of variants) {
  const env = extra === null ? { ...process.env } : { ...base };
  if (direct) env.OMNESIS_AUTH_FIXTURE_DOTNET = "1";
  if (compile) env.OMNESIS_AUTH_FIXTURE_COMPILE = "1";
  if (compile === "builtin")
    env.PSModulePath = win32.join(
      env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "Modules",
    );
  if (compile === "utility") env.OMNESIS_AUTH_FIXTURE_UTILITY = "1";
  for (const key of extra ?? []) if (process.env[key] !== undefined) env[key] = process.env[key];
  const result = await execWindowsJob(process.execPath, ["--input-type=module", "-e", launcher], {
    env: { ...process.env, OMNESIS_AUTH_FIXTURE_ENV: JSON.stringify(env) },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  process.stdout.write(`${JSON.stringify({ label, result: JSON.parse(result.stdout) })}\n`);
}
