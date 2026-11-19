// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
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
  e2eApplicationStatus,
  e2eProcessExit,
  e2eProcessOutput,
  requestE2EProcessShutdown,
  spawnE2ESubprocess,
} from "./e2e-owned-process.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";

const ROOT = join(import.meta.dirname, "../../../..");
const COLLECTOR_NAME = "invented-ipc-collector";
const GRACE_MS = 35_000;
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
    let timer: NodeJS.Timeout | undefined;
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
        output = `${output}${String(bytes)}`.slice(-16_000);
      };
      streams.stdout?.on("data", record);
      streams.stderr?.on("data", record);
      await registerSubprocessGroup(collector);
      const exited = e2eProcessExit(collector);
      void exited.catch(() => {});
      await waitForCondition(
        async () => {
          const status = e2eApplicationStatus(collector!);
          if (status.exitCode !== null || status.signalCode !== null)
            throw new Error("Collector exited before its device connected");
          const devices = await gateway.json<{
            items: Array<{ id: string; name: string; online: boolean }>;
          }>("/admin/devices");
          return devices.items.some((device) => device.name === COLLECTOR_NAME && device.online);
        },
        Math.max(0, readyDeadline - performance.now()),
        "the real Collector device to connect",
      );

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
