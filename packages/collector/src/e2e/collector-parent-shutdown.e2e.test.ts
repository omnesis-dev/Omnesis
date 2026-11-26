// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  ensureInstallRootKey,
  ensureStorageKey,
  markStorageEncryptionRequired,
  ownedProcessCleanupReceipt,
  storageKeyNamesForHost,
} from "@omnesis/core";
import { MultiCollectorHarness, waitForCondition } from "./multi-collector-harness.js";
import { e2eTsxCommand, gatewayBootBudgetMs } from "./gateway-env.js";
import {
  e2eApplicationPid,
  e2eApplicationStatus,
  e2eProcessExit,
  e2eProcessOutput,
  requestE2EProcessShutdown,
  spawnE2ESubprocess,
} from "./e2e-owned-process.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";
import type { ChildProcess } from "node:child_process";

const ROOT = join(import.meta.dirname, "../../../..");
const COLLECTOR_NAME = "invented-ipc-collector";
const GRACE_MS = 35_000;
/** What the collector logs once its gateway WebSocket is open; the device goes online next. */
const SOCKET_OPENED_LINE = "WebSocket connected to gateway at ";
let harness: MultiCollectorHarness | undefined;
let collector: ChildProcess | undefined;
let retained = false;

beforeAll(async () => {
  harness = new MultiCollectorHarness({
    extraGatewayEnv: { OMNESIS_SECRET_STORE: "file" },
  });
  try {
    const storage = { backend: "file" as const, configDir: harness.gatewayConfigDir };
    await ensureInstallRootKey(storage);
    // Match keyring storage-init --host all: provisioning belongs to fixture
    // setup, while daemon readiness observes an already configured install.
    for (const host of ["gateway", "collector"] as const)
      for (const keyName of storageKeyNamesForHost(host)) {
        const state = await ensureStorageKey(keyName, storage);
        expect(state).toMatchObject({ valid: true, encrypted: true });
      }
    await markStorageEncryptionRequired(storage.configDir, storage);
    await harness.start();
  } catch (error) {
    if (ownedProcessCleanupReceipt(error) !== undefined) retained = true;
    throw error;
  }
}, gatewayBootBudgetMs() + 30_000);

afterAll(async () => {
  const errors: unknown[] = [];
  if (collector) {
    try {
      await killSubprocessGroup(collector);
    } catch (error) {
      retained = true;
      errors.push(error);
    }
  }
  try {
    await harness?.destroy({ retainFiles: retained });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) {
    const marked = errors.find((error) => ownedProcessCleanupReceipt(error) !== undefined);
    const failure = new AggregateError(errors, "Collector IPC fixture cleanup failed", {
      cause: marked ?? errors[0],
    });
    const receipt = ownedProcessCleanupReceipt(marked);
    if (receipt !== undefined) Object.assign(failure, { cleanupFailure: receipt.failure });
    throw failure;
  }
}, 30_000);

/**
 * Why the collector never came online, in one message: which wait gave out,
 * whether its process is still running, what the gateway holds for it, and
 * the end of its own output, whose log lines carry their timestamps.
 */
async function connectDiagnosis(input: {
  error: unknown;
  collector: ChildProcess;
  spawnedAt: string;
  output: string;
  device: () => Promise<{ id: string; online: boolean } | undefined>;
}): Promise<string> {
  const reason = input.error instanceof Error ? input.error.message : String(input.error);
  let processState: string;
  try {
    const status = e2eApplicationStatus(input.collector);
    const pid = e2eApplicationPid(input.collector);
    processState =
      status.exitCode === null && status.signalCode === null
        ? `running (pid ${pid ?? "not reported"})`
        : `exited (code ${status.exitCode}, signal ${status.signalCode})`;
  } catch (error) {
    processState = `unknown: ${error instanceof Error ? error.message : String(error)}`;
  }
  let gatewayView: string;
  try {
    const device = await input.device();
    gatewayView = device
      ? `device ${device.id} registered, ${device.online ? "online" : "offline"}`
      : `no device named ${COLLECTOR_NAME}`;
  } catch (error) {
    gatewayView = `device list unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  const tail = input.output.split(/\r?\n/).slice(-60).join("\n");
  return [
    reason,
    `Collector spawned at ${input.spawnedAt}; process ${processState}; gateway: ${gatewayView}.`,
    "Collector output (last 60 lines):",
    tail || "(none)",
  ].join("\n");
}

test(
  "the real Collector CLI drains and exits zero through its inherited parent channel",
  async () => {
    const gateway = harness!;
    const command = e2eTsxCommand("packages/cli/src/index.ts");
    const env: NodeJS.ProcessEnv = {
      ...gateway.gatewayLaunchEnv,
      OMNESIS_GATEWAY_URL: gateway.gatewayUrl,
      OMNESIS_TOKEN: gateway.bootstrapToken,
      OMNESIS_SECRET_STORE: "file",
      OMNESIS_COLLECTOR_HOSTNAME: "invented-ipc",
      OMNESIS_MDNS_DISABLE: "1",
      OMNESIS_LOG_LEVEL: "info",
      NODE_EXTRA_CA_CERTS: join(gateway.gatewayConfigDir, "tls", "cert.pem"),
    };
    // The in-process pseudo-collector harness bypass must not enter this real CLI.
    delete env.NODE_TLS_REJECT_UNAUTHORIZED;
    delete env.OMNESIS_INSECURE_TLS;
    let output = "";
    let socketOpened = false;
    let timer: NodeJS.Timeout | undefined;
    const spawnedAt = new Date().toISOString();
    const readyDeadline = performance.now() + gatewayBootBudgetMs();
    try {
      collector = spawnE2ESubprocess(command.command, [...command.args, "collector", "run"], {
        cwd: ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        detached: true,
      });
      const streams = e2eProcessOutput(collector);
      const record = (bytes: Buffer): void => {
        const joined = `${output}${String(bytes)}`;
        socketOpened ||= joined.includes(SOCKET_OPENED_LINE);
        output = joined.slice(-16_000);
      };
      streams.stdout?.on("data", record);
      streams.stderr?.on("data", record);
      await registerSubprocessGroup(collector);
      const exited = e2eProcessExit(collector);
      void exited.catch(() => {});
      const running = (): void => {
        const status = e2eApplicationStatus(collector!);
        if (status.exitCode !== null || status.signalCode !== null)
          throw new Error("Collector exited before its device connected");
      };
      const device = async () =>
        (
          await gateway.json<{ items: Array<{ id: string; name: string; online: boolean }> }>(
            "/admin/devices",
          )
        ).items.find((item) => item.name === COLLECTOR_NAME);
      try {
        // The collector's own signal first, then the gateway's view of it, so
        // a stall names the side it happened on.
        await waitForCondition(
          () => {
            running();
            return socketOpened;
          },
          Math.max(0, readyDeadline - performance.now()),
          "the real Collector to open its gateway WebSocket",
        );
        await waitForCondition(
          async () => {
            running();
            return (await device())?.online === true;
          },
          Math.max(0, readyDeadline - performance.now()),
          "the gateway to list the real Collector device online",
        );
      } catch (error) {
        throw new Error(
          await connectDiagnosis({ error, collector: collector!, spawnedAt, output, device }),
          { cause: error },
        );
      }

      // This is the only shutdown request in the assertion path: a forced signal
      // cannot satisfy exit zero, the stopped diagnostic and the positive join.
      const shutdownDeadline = performance.now() + GRACE_MS;
      const graceful = (async () => {
        expect(await requestE2EProcessShutdown(collector!)).toBe(true);
        return exited;
      })();
      const code = await Promise.race([
        graceful,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Collector parent-channel shutdown exceeded 35s")),
            GRACE_MS,
          );
        }),
      ]);
      expect(code).toBe(0);
      expect(output).toContain("Shutting down collector...");
      expect(output).toContain("Collector stopped");
      await waitForCondition(
        async () => {
          const devices = await gateway.json<{ items: Array<{ name: string; online: boolean }> }>(
            "/admin/devices",
          );
          return devices.items.find((device) => device.name === COLLECTOR_NAME)?.online === false;
        },
        Math.max(0, shutdownDeadline - performance.now()),
        "the gateway to observe Collector disconnect",
      );
      expect(await gateway.json<{ version: string }>("/health")).toHaveProperty(
        "version",
        expect.any(String),
      );
    } catch (error) {
      if (ownedProcessCleanupReceipt(error) !== undefined) retained = true;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
  gatewayBootBudgetMs() + GRACE_MS + 5_000,
);
