// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { runCheckCommand } from "../../../scripts/lib/check-process.mjs";
import { authSubprocessEnvironment } from "./auth-subprocess-env.js";

const require = createRequire(import.meta.url);
const core = pathToFileURL(require.resolve("@omnesis/core")).href;
const entry = new URL("./auth-subprocess.ts", import.meta.url);
const registry = new URL("./source-descriptors.ts", import.meta.url).href;
const repository = fileURLToPath(new URL("../../../", import.meta.url));

interface Scenario {
  stage: "prime" | "marker" | "discovery" | "legacy" | "session" | "background";
  failure: "marked" | "ordinary" | "none";
  nested?: boolean;
  pending?: boolean;
}

/** Observe the real entry script, substituting its public keyring/provider seams.
 * The injected uncertainty launches no native operation. The outer command owns
 * and positively joins the held fixture before its generated inputs are removed. */
async function runScenario(scenario: Scenario) {
  const root = mkdtempSync(join(tmpdir(), "omnesis-auth-owned-entry-"));
  const primed = join(root, "primed.txt");
  const discovered = join(root, "discovered.txt");
  const invoked = join(root, "invoked.txt");
  const held = join(root, "held.txt");
  const terminal = join(root, "terminal.txt");
  const preload = join(root, "fixture-preload.mjs");
  const failure =
    scenario.failure === "marked"
      ? `Object.assign(new Error('invented cleanup uncertainty'),{cleanupFailure:undefined${scenario.pending ? ",cleanupPending:true" : ""}})`
      : `new Error('invented ordinary failure')`;
  const thrown = scenario.nested ? `new Error('invented wrapper',{cause:${failure}})` : failure;
  const original = `${core}?auth-owned-fixture-original`;
  const replacement = `
export * from ${JSON.stringify(original)};
import {OwnedProcessShutdownFence as OriginalFence} from ${JSON.stringify(original)};
import {writeFileSync} from 'node:fs';
export class OwnedProcessShutdownFence extends OriginalFence {
  constructor(onUncertain,...args){super(error=>{writeFileSync(${JSON.stringify(held)},'held');onUncertain?.(error);},...args);}
}
export async function primeSecretFileKeyCache(){
  writeFileSync(${JSON.stringify(primed)},'primed');
  ${scenario.stage === "prime" && scenario.failure !== "none" ? `throw ${thrown};` : "return true;"}
}
export function secretFileEncryptionRequired(){${scenario.stage === "marker" ? `throw ${thrown};` : "return false;"}}
`;
  const operation = `async()=>{writeFileSync(${JSON.stringify(invoked)},'invoked');${scenario.stage === "background" ? `void Promise.reject(${thrown});await new Promise(resolve=>setTimeout(resolve,150));return {accounts:[{accountId:'fixture-account',state:{}}]};` : ["legacy", "session"].includes(scenario.stage) && scenario.failure !== "none" ? `throw ${thrown};` : scenario.stage === "session" ? "return {accounts:[{accountId:'fixture-account',state:{}}]};" : "return 'fixture-account';"}}`;
  const provider = `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(discovered)},'discovered');export const allDescriptors=[{id:'fixture-auth',provider:{id:'fixture-provider'},${scenario.stage === "session" || scenario.stage === "background" ? "authenticate" : "authFlow"}:${operation}}];`;
  const registrySource =
    scenario.stage === "discovery"
      ? `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(discovered)},'discovered');export const allDescriptors=[];void Promise.reject(${thrown});await new Promise(resolve=>setTimeout(resolve,150));throw new Error('invented descriptor failure');`
      : provider;
  writeFileSync(
    preload,
    `
import {registerHooks} from 'node:module';
registerHooks({load(url,context,nextLoad){
  const base=url.split('?')[0];
  if(base===${JSON.stringify(core)}&&!url.includes('auth-owned-fixture-original'))return{format:'module',shortCircuit:true,source:${JSON.stringify(replacement)}};
  if(base===${JSON.stringify(registry)}||base===${JSON.stringify(registry.slice(0, -3) + ".js")})return{format:'module',shortCircuit:true,source:${JSON.stringify(registrySource)}};
  return nextLoad(url,context);
}});
`,
  );
  const signals = new EventEmitter();
  let settled = false;
  let retained = false;
  const args = [
    "--import",
    pathToFileURL(require.resolve("tsx/esm")).href,
    "--import",
    pathToFileURL(preload).href,
    fileURLToPath(entry),
    "fixture-auth",
  ];
  const init = JSON.stringify({ type: "init", flowId: "fixture-flow" }) + "\n";
  const driver = `import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';const child=spawn(process.execPath,${JSON.stringify(args)},{stdio:['pipe','pipe','inherit']});let output='';child.stdout.on('data',chunk=>{output+=String(chunk);if(/\"type\":\"(?:complete|error)\"/.test(output))writeFileSync(${JSON.stringify(terminal)},'terminal');});child.stdin.on('error',()=>{});child.stdin.end(${JSON.stringify(init)});child.once('error',()=>{process.exitCode=1;});child.once('exit',code=>{process.exitCode=code??1;});`;
  const running = runCheckCommand(process.execPath, ["--input-type=module", "-e", driver], {
    cwd: repository,
    env: authSubprocessEnvironment(root, {
      ...process.env,
      OMNESIS_SECRET_STORE: "file",
      OMNESIS_AUTH_PROCESS_NONCE: "a".repeat(64),
    }),
    signalEmitter: signals as NodeJS.Process,
  }).finally(() => {
    settled = true;
  });
  void running.catch(() => {});
  try {
    const deadline = Date.now() + 20_000;
    while (!settled && !existsSync(held) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(existsSync(primed), "the real script must reach the injected keyring operation").toBe(
      true,
    );
    if (scenario.failure === "marked") {
      expect(existsSync(held), "cleanup uncertainty must reach the process exit fence").toBe(true);
      expect(settled, "the uncertain process must retain its original PID").toBe(false);
      // Let a provider that continues after a background rejection try to report success.
      if (scenario.stage === "background" || scenario.stage === "discovery")
        await new Promise((resolve) => setTimeout(resolve, 250));
      expect(
        existsSync(terminal),
        "uncertainty must not become an ordinary terminal auth event",
      ).toBe(false);
      expect(existsSync(discovered)).toBe(
        scenario.stage !== "prime" && scenario.stage !== "marker",
      );
      expect(existsSync(invoked)).toBe(!["prime", "marker", "discovery"].includes(scenario.stage));
    } else {
      expect(settled, "ordinary outcomes must remain able to exit").toBe(true);
      expect(existsSync(held)).toBe(false);
      expect(
        existsSync(terminal),
        "ordinary provider outcomes must report their terminal auth event",
      ).toBe(scenario.stage !== "discovery");
      expect(existsSync(discovered)).toBe(true);
      expect(existsSync(invoked)).toBe(scenario.stage !== "discovery");
      const result = await running;
      expect(result).toBe(
        scenario.failure === "ordinary" &&
          scenario.stage !== "prime" &&
          scenario.stage !== "marker" &&
          scenario.stage !== "background"
          ? 1
          : 0,
      );
    }
  } finally {
    const stopping = !settled;
    if (stopping) signals.emit("SIGTERM");
    try {
      await running;
    } catch (error) {
      retained = ownedProcessCleanupReceipt(error) !== undefined;
      const cancelled =
        error instanceof Error &&
        error.message ===
          (process.platform === "win32"
            ? "Check process did not complete normally"
            : "Check terminated after SIGTERM");
      if (retained || !stopping || !cancelled) throw error;
    } finally {
      if (!retained) rmSync(root, { recursive: true, force: true });
    }
  }
}

for (const stage of ["prime", "marker", "discovery", "legacy", "session", "background"] as const) {
  test.each([false, true])(
    `the real ${stage} path retains cleanup uncertainty (nested=%s)`,
    async (nested) => runScenario({ stage, failure: "marked", nested }),
    30_000,
  );
  test(
    `the real ${stage} path preserves ordinary failure behavior`,
    async () => runScenario({ stage, failure: "ordinary" }),
    30_000,
  );
}
test(
  "the real successful session path remains able to exit",
  async () => runScenario({ stage: "session", failure: "none" }),
  30_000,
);

test(
  "the real successful legacy path remains able to exit",
  async () => runScenario({ stage: "legacy", failure: "none" }),
  30_000,
);

for (const stage of ["prime", "session"] as const)
  test(
    `the real ${stage} path cannot discharge a pending marker without a retained closure proof`,
    async () => runScenario({ stage, failure: "marked", pending: true }),
    30_000,
  );
