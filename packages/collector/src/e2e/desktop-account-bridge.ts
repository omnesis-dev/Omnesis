// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { e2eGatewayEnv } from "./gateway-env.js";
import type { DesktopRuntimeFixture } from "./desktop-runtime-fixture.js";

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
    const install=await desktopCoordinatorDefaults.prepareInstall(...args);
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
    return install;
  },
});
const controller=new AbortController();
const abort=()=>controller.abort();
process.once('SIGINT',abort);process.once('SIGTERM',abort);
try { await runDesktopProtocol({input:process.stdin,output:process.stdout,signal:controller.signal,handle:(request,context)=>coordinator.handle(request,context)}); }
finally {await coordinator.close();process.off('SIGINT',abort);process.off('SIGTERM',abort);}
`,
    { mode: 0o600 },
  );
  await fixture.useOwnedBridgeEntry(path);
}
