// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { constants, copyFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";

/** Actual child processes, no shell shims and no preinstalled workspace aliases. */
export function npmCiFixture(root, actions = ["ok"], { clean = false } = {}) {
  const checkout = clean ? join(root, "checkout") : join(import.meta.dirname, "..", "..");
  if (clean) {
    for (const file of [
      "scripts/ci/npm-ci.mjs",
      "scripts/lib/bootstrap-platform.mjs",
      "scripts/lib/check-process-runtime.mjs",
      "packages/core/src/parent-shutdown.ts",
    ]) {
      mkdirSync(dirname(join(checkout, file)), { recursive: true });
      copyFileSync(join(import.meta.dirname, "..", "..", file), join(checkout, file));
    }
    cpSync(
      join(import.meta.dirname, "..", "..", "packages/platform/src"),
      join(checkout, "packages/platform/src"),
      { recursive: true },
    );
  }
  const node = join(root, "runtime", "bin", process.platform === "win32" ? "node.exe" : "node");
  mkdirSync(dirname(node), { recursive: true });
  copyFileSync(process.execPath, node, constants.COPYFILE_FICLONE);
  const npm = join(root, "npm", "bin", "npm-cli.js");
  const gyp = join(root, "npm", "node_modules", "node-gyp", "bin", "node-gyp.js");
  mkdirSync(dirname(npm), { recursive: true });
  mkdirSync(dirname(gyp), { recursive: true });
  const events = join(root, "events.jsonl");
  const marker = join(root, "ready.json");
  writeFileSync(
    gyp,
    `const fs=require('node:fs'), path=require('node:path');
    const args=process.argv.slice(2); const version=args[1];
    const devdir=args.find(v=>v.startsWith('--devdir=')).slice(9);
    const arch=args.find(v=>v.startsWith('--arch=')).slice(7);
    const root=path.join(devdir,version); const dir=path.join(root,'include','node');
    fs.mkdirSync(dir,{recursive:true});
    for(const name of ['node.h','node_api.h','common.gypi','config.gypi'])fs.writeFileSync(path.join(dir,name),name.endsWith('.gypi')?'{}':'header');
    fs.writeFileSync(path.join(dir,'node_version.h'),version.split('.').map((value,i)=>'#define NODE_'+['MAJOR','MINOR','PATCH'][i]+'_VERSION '+value).join('\\n'));
    fs.mkdirSync(path.join(root,arch),{recursive:true}); fs.writeFileSync(path.join(root,arch,'node.lib'),'synthetic import library');
    fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({stage:'headers',version,arch,root})+'\\n');`,
  );
  writeFileSync(
    npm,
    `const fs=require('node:fs'), path=require('node:path');
    const args=process.argv.slice(2); const events=${JSON.stringify(events)};
    const headers=process.env.npm_package_config_node_gyp_nodedir;
    if(!headers||!fs.existsSync(path.join(headers,'include','node','node.h')))throw Error('headers unavailable before native install');
    if(process.platform==='win32'&&!fs.existsSync(path.join(headers,'Release','node.lib')))throw Error('explicit nodedir lacks Release/node.lib');
    fs.appendFileSync(events,JSON.stringify({stage:'ci',args,headers,legacy:process.env.npm_config_nodedir??null,target:process.env.npm_package_config_node_gyp_target,arch:process.env.npm_package_config_node_gyp_arch})+'\\n');
    const count=fs.readFileSync(events,'utf8').trim().split('\\n').filter(l=>JSON.parse(l).stage==='ci').length;
    const action=${JSON.stringify(actions)}[count-1]??'ok';
    const logs=args[args.indexOf('--logs-dir')+1]; fs.mkdirSync(logs,{recursive:true});
    if(action==='drop'||action==='both')fs.writeFileSync(path.join(logs,'debug.log'),['@scope/binding','ffmpeg-static'].map(name=>'2 verbose reify failed optional dependency '+path.join(process.cwd(),'node_modules',name)+'\\n').join(''));
    if(action==='whisper'||action==='both')fs.appendFileSync(path.join(logs,'debug.log'),['smart-whisper','smart-whisper/node_modules/node-addon-api'].map(name=>'3 verbose reify failed optional dependency '+path.join(process.cwd(),'node_modules',name)+'\\n').join(''));
    if(action==='fail')process.exit(1);
    if(action==='hang'){
      const childScript='const fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,headers:process.argv[2]}));setInterval(()=>{},1000)';
      require('node:child_process').spawn(process.execPath,['-e',childScript,${JSON.stringify(marker)},headers],{stdio:'inherit'});
      process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
    }`,
  );
  const start = (args = [], extraEnv = {}) => {
    const child = spawn(node, [join(checkout, "scripts/ci/npm-ci.mjs"), ...args], {
      cwd: root,
      env: {
        ...process.env,
        npm_execpath: npm,
        npm_config_nodedir: "untrusted previous cache",
        NPM_CI_ATTEMPTS: "3",
        NPM_CI_RETRY_SECONDS: "0",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: process.platform !== "win32",
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    const result = new Promise((resolve, reject) => {
      child.once("error", reject);
      // The parent may disconnect IPC to request cleanup. Observe real exit
      // and drained output without depending on ChildProcess's IPC close count.
      child.once("exit", (code) => {
        void Promise.all([finished(child.stdout), finished(child.stderr)]).then(
          () => resolve({ code, stdout, stderr }),
          reject,
        );
      });
    });
    return { child, result };
  };
  return { root, checkout, marker, events, start, npmCli: npm, nodePath: node };
}
