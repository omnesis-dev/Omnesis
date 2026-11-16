// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { spawnE2ESubprocess, e2eProcessExit, e2eProcessOutput } from "./e2e-owned-process.js";
import { e2eGatewayEnv, e2eTsxCommand } from "./gateway-env.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";
import { GATEWAY_TAILNET_ORIGIN } from "./tailnet-fixture-addresses.js";
import { tailnetFixtureEnv } from "./tailnet-machine-env.js";
import type { TailnetMachine } from "./tailnet-harness.js";

const commands = new WeakMap<TailnetMachine, Set<ChildProcess>>();
const REPO_ROOT = join(import.meta.dirname, "../../../..");

export function tailnetCleanupError(errors: unknown[]): AggregateError {
  const receipt = errors.map(ownedProcessCleanupReceipt).find((value) => value !== undefined);
  const error = new AggregateError(errors, "Tailnet fixture cleanup failed");
  return receipt ? Object.assign(error, { cleanupFailure: receipt.failure }) : error;
}

/** Close every command independently; rejected owners keep their shared inputs. */
export async function stopTailnetCommands(machines: readonly TailnetMachine[]): Promise<void> {
  const work = machines.flatMap((machine) =>
    [...(commands.get(machine) ?? [])].map((child) => ({ machine, child })),
  );
  const results = await Promise.allSettled(
    work.map(async ({ machine, child }) => {
      await killSubprocessGroup(child);
      commands.get(machine)?.delete(child);
    }),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw tailnetCleanupError(failures.map((failure) => failure.reason as unknown));
}

/** The real CLI uses this peer's official Tailscale CLI and encrypted proxy. */
export function runCliOn(
  machine: TailnetMachine,
  caCertFile: string,
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const configDir = join(machine.dir, "omnesis");
  mkdirSync(configDir, { recursive: true });
  const command = e2eTsxCommand("packages/cli/src/index.ts");
  const child = spawnE2ESubprocess(command.command, [...command.args, ...args], {
    cwd: REPO_ROOT,
    env: tailnetFixtureEnv({
      ...e2eGatewayEnv(),
      ...machine.env(caCertFile),
      OMNESIS_CONFIG_DIR: configDir,
      OMNESIS_TAILSCALE_EMBED_ENABLED: "1",
      OMNESIS_LOG_LEVEL: "error",
      OMNESIS_GATEWAY_URL: GATEWAY_TAILNET_ORIGIN,
      OMNESIS_TOKEN: undefined,
      NODE_TLS_REJECT_UNAUTHORIZED: undefined,
      ...extraEnv,
    }),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const registered = commands.get(machine) ?? new Set<ChildProcess>();
  commands.set(machine, registered);
  registered.add(child);
  let stdout = "",
    stderr = "";
  const out = new StringDecoder("utf8"),
    err = new StringDecoder("utf8");
  const output = e2eProcessOutput(child);
  output.stdout!.on("data", (bytes: Buffer) => {
    stdout += out.write(bytes);
  });
  output.stderr!.on("data", (bytes: Buffer) => {
    stderr += err.write(bytes);
  });
  const result = (async () => {
    try {
      const [, code] = await Promise.all([registerSubprocessGroup(child), e2eProcessExit(child)]);
      await killSubprocessGroup(child);
      registered.delete(child);
      stdout += out.end();
      stderr += err.end();
      return { code, stdout, stderr };
    } catch (error) {
      try {
        await killSubprocessGroup(child);
        registered.delete(child);
      } catch (cleanup) {
        throw tailnetCleanupError([error, cleanup]);
      }
      throw error;
    }
  })();
  // Approval is observed before awaiting the CLI. A transport failure stays
  // available to that later await while teardown retains the process owner.
  void result.catch(() => {});
  return result;
}
