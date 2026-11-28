// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const startupRoles = ["daemon", "gateway", "collector"] as const;
type StartupRole = (typeof startupRoles)[number];
const startupCategories = [
  "none",
  "missing-file",
  "module",
  "permission",
  "network",
  "certificate",
  "other",
] as const;
type StartupRecord = {
  format: 1;
  role: StartupRole;
  entered: true;
  uncaught: boolean;
  category: (typeof startupCategories)[number];
  exit: "pending" | "zero" | "nonzero";
};
const startupDirectory = (directory: string) => join(directory, "startup-observations");
const startupIdentity = (info: import("node:fs").Stats) =>
  [info.dev, info.ino, info.uid, info.mode, info.nlink, info.size, info.mtimeMs, info.ctimeMs].join(
    ":",
  );

/** First-attempt observations only; absence or an exit event is not a process-ownership receipt. */
export async function readDesktopStartupObservations(
  directory: string,
): Promise<Record<StartupRole, StartupRecord | "unknown">> {
  const result: Record<StartupRole, StartupRecord | "unknown"> = {
    daemon: "unknown",
    gateway: "unknown",
    collector: "unknown",
  };
  const parent = startupDirectory(directory);
  try {
    const info = await lstat(parent);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o700 ||
      info.uid !== process.getuid?.() ||
      (await realpath(parent)) !== parent
    )
      return result;
    for (const role of startupRoles) {
      try {
        const path = join(parent, `${role}.json`);
        const handle = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const before = await handle.stat();
          if (
            !before.isFile() ||
            before.uid !== info.uid ||
            before.nlink !== 1 ||
            (before.mode & 0o777) !== 0o600 ||
            before.size > 1024
          )
            continue;
          const bytes = Buffer.alloc(1025);
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          if (
            bytesRead !== before.size ||
            startupIdentity(before) !== startupIdentity(await handle.stat()) ||
            startupIdentity(before) !== startupIdentity(await lstat(path)) ||
            startupIdentity(info) !== startupIdentity(await lstat(parent)) ||
            (await realpath(parent)) !== parent
          )
            continue;
          const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const record = value as Record<string, unknown>;
          if (
            Object.keys(record).sort().join(",") !== "category,entered,exit,format,role,uncaught" ||
            record.format !== 1 ||
            record.role !== role ||
            record.entered !== true ||
            typeof record.uncaught !== "boolean" ||
            !startupCategories.includes(record.category as StartupRecord["category"]) ||
            typeof record.exit !== "string" ||
            !["pending", "zero", "nonzero"].includes(record.exit) ||
            (record.uncaught ? record.category === "none" : record.category !== "none")
          )
            continue;
          result[role] = {
            format: 1,
            role,
            entered: true,
            uncaught: record.uncaught,
            category: record.category as StartupRecord["category"],
            exit: record.exit as StartupRecord["exit"],
          };
        } finally {
          await handle.close();
        }
      } catch {
        /* Missing, unsafe or concurrently changing observations stay unknown. */
      }
    }
  } catch {
    /* Observation failures never replace the original fixture failure. */
  }
  return result;
}

function startupObserver(directory: string, sourceRoot: string): string {
  return `
import * as observerFs from 'node:fs';
const observerRole = process.argv[1] === ${JSON.stringify(join(sourceRoot, "packages/cli/src/index.ts"))} && process.argv[2] === 'desktop' && process.argv[3] === 'daemon' ? 'daemon' : process.argv[1] === ${JSON.stringify(join(sourceRoot, "packages/cli/src/desktop/component-process.ts"))} && ['gateway','collector'].includes(process.argv[2]) ? process.argv[2] : undefined;
if (observerRole) {
  let observerFd;
  let observerBefore;
  const observerPath = ${JSON.stringify(startupDirectory(directory))} + '/' + observerRole + '.json';
  const observerState = {format:1,role:observerRole,entered:true,uncaught:false,category:'none',exit:'pending'};
  const observerSame = (a,b) => a.dev===b.dev && a.ino===b.ino && a.uid===b.uid && a.mode===b.mode && a.nlink===b.nlink;
  const observerWrite = () => {
    try {
      if(observerFd===undefined)return;
      const current=observerFs.fstatSync(observerFd), named=observerFs.lstatSync(observerPath);
      if(!current.isFile() || current.nlink!==1 || current.uid!==process.getuid() || (current.mode&511)!==384 || !observerSame(observerBefore,current) || !observerSame(current,named))return;
      const bytes=Buffer.from(JSON.stringify(observerState));
      if(bytes.length>1024)return;
      observerFs.ftruncateSync(observerFd,0);
      let written=0;
      while(written<bytes.length){const count=observerFs.writeSync(observerFd,bytes,written,bytes.length-written,written);if(count<=0)return;written+=count;}
    } catch {}
  };
  try {
    const parent=observerFs.lstatSync(${JSON.stringify(startupDirectory(directory))});
    if(parent.isDirectory()&&!parent.isSymbolicLink()&&parent.uid===process.getuid()&&(parent.mode&511)===448&&observerFs.realpathSync(${JSON.stringify(startupDirectory(directory))})===${JSON.stringify(startupDirectory(directory))}){
      observerFd=observerFs.openSync(observerPath,observerFs.constants.O_WRONLY|observerFs.constants.O_CREAT|observerFs.constants.O_EXCL|observerFs.constants.O_NOFOLLOW|observerFs.constants.O_NONBLOCK,384);
      observerBefore=observerFs.fstatSync(observerFd);
      observerWrite();
    }
  } catch {}
  if(observerFd!==undefined){
    process.on('uncaughtExceptionMonitor',(error)=>{
      if(observerState.uncaught)return;
      observerState.uncaught=true;
      observerState.category='other';
      try {
        const code=error&&typeof error==='object'?error.code:undefined;
        if(code==='ENOENT')observerState.category='missing-file';
        else if(['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND'].includes(code))observerState.category='module';
        else if(['EACCES','EPERM'].includes(code))observerState.category='permission';
        else if(['ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN'].includes(code))observerState.category='network';
        else if(['ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code))observerState.category='certificate';
      }catch{}
      observerWrite();
    });
    process.once('exit',(code)=>{
      observerState.exit=code===0?'zero':'nonzero';observerWrite();
      try{observerFs.closeSync(observerFd);}catch{}
    });
  }
}
`;
}

/** Linux source E2E substitute for the packaged native adapter's fixed Node trust policy. */
export async function createDesktopNodeAdapter(
  directory: string,
  options: { startupObservation?: boolean; sourceRoot?: string } = {},
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const executable = join(directory, "desktop-node"),
    registration = join(directory, "runtime-policy.mjs");
  if (options.startupObservation) await mkdir(startupDirectory(directory), { mode: 0o700 });
  await writeFile(
    registration,
    `Object.defineProperty(process, 'execPath', {value:${JSON.stringify(executable)},writable:false,configurable:false});\n` +
      (options.startupObservation
        ? startupObserver(
            directory,
            options.sourceRoot ?? fileURLToPath(new URL("../../../../", import.meta.url)),
          )
        : ""),
    { mode: 0o600 },
  );
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  await writeFile(
    executable,
    `#!/bin/sh\nexec ${quote(process.execPath)} --use-system-ca --import ${quote(pathToFileURL(registration).href)} "$@"\n`,
    { mode: 0o700 },
  );
  return executable;
}
