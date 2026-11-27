// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "@omnesis/core";
import { e2eGatewayEnv } from "./gateway-env.js";
import type { DesktopRuntimeFixture } from "./desktop-runtime-fixture.js";

export const desktopPrepareStages = [
  "handle-entered",
  "install-entered",
  "install-returned",
  "fixture-configured",
  "runtime-entered",
  "runtime-returned",
  "handoff-entered",
  "handoff-returned",
  "daemon-entered",
  "daemon-returned",
  "first-health-entered",
  "first-health-failed",
  "first-health-returned",
  "model-entered",
  "model-returned",
  "handle-returned",
  "handle-threw",
  "protocol-returned",
  "coordinator-close-entered",
  "coordinator-close-returned",
] as const;
type PrepareStage = (typeof desktopPrepareStages)[number];
const prepareFailureCategories = [
  "refused",
  "timeout",
  "dns",
  "certificate",
  "auth",
  "other",
] as const;
type PrepareFailureCategory = (typeof prepareFailureCategories)[number];
const prepareStages = new Set<string>(desktopPrepareStages);
const unknownPrepareProgress = () => ({ stage: "unknown" as const, seen: [] as PrepareStage[] });
const prepareProgressPath = (root: string) => join(root, "prepare-progress.json");
const metadataIdentity = (info: Stats) =>
  [info.dev, info.ino, info.uid, info.mode, info.nlink, info.size, info.mtimeMs, info.ctimeMs].join(
    ":",
  );

/** Inspect only direct code/status fields; never messages, causes, hostnames or URLs. */
export function desktopPrepareFailureCategory(value: unknown): PrepareFailureCategory {
  try {
    if (!value || typeof value !== "object") return "other";
    const error = value as Record<string, unknown>;
    const code = typeof error.code === "string" ? error.code : "";
    if (code === "ECONNREFUSED") return "refused";
    if (["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code)) return "timeout";
    if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME"].includes(code)) return "dns";
    if (
      [
        "ERR_TLS_CERT_ALTNAME_INVALID",
        "CERT_HAS_EXPIRED",
        "CERT_NOT_YET_VALID",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      ].includes(code)
    )
      return "certificate";
    if (
      error.status === 401 ||
      error.status === 403 ||
      error.statusCode === 401 ||
      error.statusCode === 403
    )
      return "auth";
    return "other";
  } catch {
    return "other";
  }
}

/** Project only finite observations; a returned handler is not a successful setup receipt. */
export function desktopPrepareProgress(value: unknown): {
  stage: PrepareStage | "unknown";
  seen: PrepareStage[];
  firstHealthFailure?: PrepareFailureCategory;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unknownPrepareProgress();
  const object = value as Record<string, unknown>;
  if (
    !["format,seen,stage", "firstHealthFailure,format,seen,stage"].includes(
      Object.keys(object).sort().join(","),
    ) ||
    object.format !== 1 ||
    typeof object.stage !== "string" ||
    !prepareStages.has(object.stage) ||
    !Array.isArray(object.seen) ||
    object.seen.length === 0 ||
    object.seen.length > desktopPrepareStages.length ||
    object.seen.some((stage: unknown) => typeof stage !== "string" || !prepareStages.has(stage)) ||
    new Set(object.seen).size !== object.seen.length ||
    object.seen.at(-1) !== object.stage ||
    object.seen.includes("first-health-failed") !== Object.hasOwn(object, "firstHealthFailure")
  )
    return unknownPrepareProgress();
  const category =
    prepareFailureCategories.find((entry) => entry === object.firstHealthFailure) ?? "other";
  return {
    stage: object.stage as PrepareStage,
    seen: [...object.seen] as PrepareStage[],
    ...(Object.hasOwn(object, "firstHealthFailure") ? { firstHealthFailure: category } : {}),
  };
}

async function assertPrepareRoot(root: string): Promise<void> {
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid()) ||
    (await realpath(root)) !== resolve(root)
  )
    throw new Error("The prepare journal root is not private and owned");
}

function privatePrepareFile(info: Stats): boolean {
  return (
    info.isFile() &&
    info.nlink === 1 &&
    (info.mode & 0o777) === 0o600 &&
    (!process.getuid || info.uid === process.getuid()) &&
    info.size <= 1024
  );
}

/** Test-owned observations only; recording does not change operation results or deadlines. */
export function createDesktopPrepareProgress(root: string) {
  const seen = new Set<PrepareStage>();
  let active = false;
  let firstHealthFailure: PrepareFailureCategory | undefined;
  let pending = Promise.resolve();
  const record = async (value: unknown, failure?: unknown): Promise<void> => {
    if (!active) return;
    if (typeof value !== "string" || !prepareStages.has(value))
      throw new Error("Unknown prepare journal stage");
    const stage = value as PrepareStage;
    if (seen.has(stage)) return pending;
    seen.add(stage);
    if (stage === "first-health-failed")
      firstHealthFailure = desktopPrepareFailureCategory(failure);
    const body = JSON.stringify({
      format: 1,
      stage,
      seen: [...seen],
      ...(firstHealthFailure ? { firstHealthFailure } : {}),
    });
    if (Buffer.byteLength(body) > 1024) throw new Error("The prepare journal exceeded its bound");
    pending = pending
      .catch(() => {})
      .then(async () => {
        await assertPrepareRoot(root);
        const path = prepareProgressPath(root);
        const previous = await lstat(path).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        });
        if (previous && !privatePrepareFile(previous)) throw new Error("Unsafe prepare journal");
        await atomicWriteFile(path, body, { mode: 0o600 });
      });
    return pending;
  };
  return {
    begin: async () => {
      active = true;
      await record("handle-entered");
    },
    record,
  };
}

/** Read before fixture cleanup, never turn unsafe/missing observations into a diagnosis. */
export async function readDesktopPrepareProgress(root: string) {
  try {
    await assertPrepareRoot(root);
    const path = prepareProgressPath(root);
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!privatePrepareFile(before)) return unknownPrepareProgress();
      const bytes = Buffer.alloc(1025);
      let used = 0;
      while (used < bytes.length) {
        const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      if (
        used !== before.size ||
        metadataIdentity(before) !== metadataIdentity(await handle.stat()) ||
        metadataIdentity(before) !== metadataIdentity(await lstat(path))
      )
        return unknownPrepareProgress();
      return desktopPrepareProgress(JSON.parse(bytes.subarray(0, used).toString("utf8")));
    } finally {
      await handle.close();
    }
  } catch {
    return unknownPrepareProgress();
  }
}

/**
 * Source-distribution seam: name the owned relay before discovery, and provision local fixture
 * endpoints only AFTER the real bootstrap has claimed/protected a fresh profile. Authentication,
 * enrollment, pairing, lifecycle and all stores remain the production implementations.
 */
export async function installDesktopAccountBridge(
  fixture: DesktopRuntimeFixture,
  gatewayEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const moduleUrl = (name: string) => new URL(`../../../cli/src/${name}.ts`, import.meta.url).href;
  const path = join(fixture.root, "account-bridge.mjs");
  const core = pathToFileURL(createRequire(import.meta.url).resolve("@omnesis/core")).href;
  const dotenv =
    Object.entries({
      ...e2eGatewayEnv({}),
      ...gatewayEnv,
      OMNESIS_CLOUD_RELAY_URL: fixture.relayUrl,
    })
      .filter((entry) => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n";
  await writeFile(
    path,
    `
import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
const {initializeDesktopEnvironment}=await import(${JSON.stringify(moduleUrl("desktop/environment"))});
const profile=initializeDesktopEnvironment();
process.argv.splice(2,process.argv.length-2,'desktop','bridge');
await import(${JSON.stringify(moduleUrl("load-env"))});
const {DesktopCoordinator}=await import(${JSON.stringify(moduleUrl("desktop/coordinator"))});
const {desktopCoordinatorDefaults}=await import(${JSON.stringify(moduleUrl("desktop/coordinator-runtime"))});
const {withDesktopInstallLease}=await import(${JSON.stringify(moduleUrl("desktop/bootstrap"))});
const {runDesktopProtocol}=await import(${JSON.stringify(moduleUrl("desktop/protocol"))});
const {atomicWriteFile}=await import(${JSON.stringify(core)});
const {desktopAccountProgress}=await import(${JSON.stringify(new URL("./desktop-account-mixed-fixture.ts", import.meta.url).href)});
const {createDesktopPrepareProgress}=await import(${JSON.stringify(new URL("./desktop-account-bridge.ts", import.meta.url).href)});
const progress=createDesktopPrepareProgress(${JSON.stringify(fixture.root)});
let preparing=false;
const note=(stage,failure)=>progress.record(stage,failure).catch(()=>{});
const prepareStage=(stage,failure)=>preparing?note(stage,failure):Promise.resolve();
const provisioned=${JSON.stringify(join(fixture.root, "profile-provisioned"))};
const coordinator=new DesktopCoordinator(profile,{
  relayUrl:()=>${JSON.stringify(fixture.relayUrl)},
  connectAccount:(current,params,context)=>desktopCoordinatorDefaults.connectAccount(current,params,context,{
    request:async(...args)=>{
      const result=await desktopCoordinatorDefaults.request(...args);
      if(args[1]==='/admin/cloud-relay'||args[1]==='/admin/cloud-relay/connect')
        await atomicWriteFile(${JSON.stringify(join(fixture.root, "account-progress.json"))},JSON.stringify(desktopAccountProgress(result)),{mode:0o600}).catch(()=>{});
      return result;
    },
  }),
  prepareInstall:async(...args)=>{
    await prepareStage('install-entered');
    const install=await desktopCoordinatorDefaults.prepareInstall(...args);
    await prepareStage('install-returned');
    await withDesktopInstallLease(profile,args[1].signal,async()=>{
      const exists=await lstat(provisioned).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(exists)return;
      const configPath=join(profile.configDir,'omnesis.json');
      const config=JSON.parse(await readFile(configPath,'utf8'));
      config.inference.assignments={...config.inference.assignments,embedder:null};
      await atomicWriteFile(configPath,JSON.stringify(config),{mode:0o600});
      await atomicWriteFile(join(profile.configDir,'.env'),${JSON.stringify(dotenv)},{mode:0o600});
      await atomicWriteFile(provisioned,'owned-fixture-configuration',{mode:0o600});
    });
    await prepareStage('fixture-configured');
    return install;
  },
  prepareRuntime:async(...args)=>{
    await prepareStage('runtime-entered');
    const result=await desktopCoordinatorDefaults.prepareRuntime(...args);
    await prepareStage('runtime-returned');
    return result;
  },
  backgroundHandoff:async(...args)=>{
    await prepareStage('handoff-entered');
    const result=await desktopCoordinatorDefaults.backgroundHandoff(...args);
    await prepareStage('handoff-returned');
    return result;
  },
  startDaemon:async(...args)=>{
    await prepareStage('daemon-entered');
    const result=await desktopCoordinatorDefaults.startDaemon(...args);
    await prepareStage('daemon-returned');
    return result;
  },
  request:async(...args)=>{
    const health=preparing&&args[1]==='/health';
    if(health)await prepareStage('first-health-entered');
    try {
      const result=await desktopCoordinatorDefaults.request(...args);
      if(health)await prepareStage('first-health-returned');
      return result;
    }catch(error){
      if(health)await prepareStage('first-health-failed',error);
      throw error;
    }
  },
  searchModel:async(...args)=>{
    await prepareStage('model-entered');
    const result=await desktopCoordinatorDefaults.searchModel(...args);
    await prepareStage('model-returned');
    return result;
  },
});
const controller=new AbortController();
const abort=()=>controller.abort();
process.once('SIGINT',abort);process.once('SIGTERM',abort);
try {
  await runDesktopProtocol({input:process.stdin,output:process.stdout,signal:controller.signal,handle:async(request,context)=>{
    const observed=request.command==='prepare';
    if(observed){preparing=true;await progress.begin().catch(()=>{});}
    try {
      const result=await coordinator.handle(request,context);
      if(observed)await note('handle-returned');
      return result;
    }catch(error){
      if(observed)await note('handle-threw');
      throw error;
    }finally{if(observed)preparing=false;}
  }});
  await note('protocol-returned');
}
finally {
  await note('coordinator-close-entered');
  await coordinator.close();
  await note('coordinator-close-returned');
  process.off('SIGINT',abort);process.off('SIGTERM',abort);
}
`,
    { mode: 0o600 },
  );
  await fixture.useOwnedBridgeEntry(path);
}
