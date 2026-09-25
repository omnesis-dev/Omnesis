// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Fail-closed boot E2E: the real gateway PROCESS must refuse to start — exit
 * non-zero and never listen — when at-rest encryption cannot be honored
 * safely. The unit tests assert `resolveGatewayStorageEncryptionKeys` throws;
 * this asserts the boot wiring in `index.ts` actually turns that throw into a
 * dead process rather than a fail-OPEN gateway serving a plaintext corpus.
 *
 * Two ways the invariant can break, each proven against a spawned gateway:
 *   - a tampered fail-closed marker         → "failed integrity verification"
 *   - a present root key that will not open → "cannot be read" (wrong passphrase)
 */

import { spawn } from "node:child_process";
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstallRootKey, markStorageEncryptionRequired } from "@omnesis/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { e2eGatewayEnv, e2eTsxCommand } from "./gateway-env.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";

const REPO_ROOT = join(import.meta.dirname, "../../../..");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

interface BootAttempt {
  code: number | null;
  output: string;
  acceptedConnection: boolean;
}

/**
 * Spawn the gateway entrypoint through the local tsx loader and resolve
 * once it exits, probing its port throughout to prove it never listened.
 */
async function spawnGatewayExpectingExit(
  configDir: string,
  port: number,
  extraEnv: Record<string, string>,
): Promise<BootAttempt> {
  const gatewayCommand = e2eTsxCommand("packages/gateway/src/index.ts");
  const child = spawn(gatewayCommand.command, gatewayCommand.args, {
    cwd: REPO_ROOT,
    env: {
      ...e2eGatewayEnv(),
      OMNESIS_CONFIG_DIR: configDir,
      OMNESIS_DB_PATH: join(configDir, "omnesis.db"),
      OMNESIS_INDEX_DB_PATH: join(configDir, "index.db"),
      OMNESIS_ANALYTICS_DB_PATH: join(configDir, "analytics.db"),
      OMNESIS_GATEWAY_PORT: String(port),
      OMNESIS_MDNS_DISABLE: "1",
      OMNESIS_PARENT_PID: String(process.pid),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  registerSubprocessGroup(child);

  let output = "";
  child.stdout.on("data", (b: Buffer) => (output += b.toString()));
  child.stderr.on("data", (b: Buffer) => (output += b.toString()));

  let acceptedConnection = false;
  const sockets = new Set<Socket>();
  const pendingProbes = new Set<Promise<void>>();
  const probe = () => {
    const pending = new Promise<void>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      sockets.add(socket);
      let settled = false;
      const finish = (connected: boolean) => {
        if (settled) return;
        settled = true;
        if (connected) acceptedConnection = true;
        sockets.delete(socket);
        socket.destroy();
        resolve();
      };
      socket.setTimeout(100);
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.once("timeout", () => finish(false));
    });
    pendingProbes.add(pending);
    void pending.finally(() => pendingProbes.delete(pending));
  };
  probe();
  const poll = setInterval(probe, 100);

  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`gateway did not exit within 45s; output:\n${output}`));
      }, 45_000);
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    clearInterval(poll);
    await Promise.all(pendingProbes);
    for (const socket of sockets) socket.destroy();
    await killSubprocessGroup(child);
  }
  return { code, output, acceptedConnection };
}

const dirs: string[] = [];
let priorSecretStore: string | undefined;
let priorPassphrase: string | undefined;

beforeEach(() => {
  priorSecretStore = process.env.OMNESIS_SECRET_STORE;
  priorPassphrase = process.env.OMNESIS_KEYRING_PASSPHRASE;
});
afterEach(() => {
  restore("OMNESIS_SECRET_STORE", priorSecretStore);
  restore("OMNESIS_KEYRING_PASSPHRASE", priorPassphrase);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function restore(key: string, prior: string | undefined): void {
  if (prior === undefined) delete process.env[key];
  else process.env[key] = prior;
}
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-failclosed-"));
  dirs.push(dir);
  return dir;
}

describe("gateway boot fails closed at the process level", () => {
  test("a tampered fail-closed marker exits the process, never serving", async () => {
    const configDir = tmp();
    process.env.OMNESIS_SECRET_STORE = "file";
    await ensureInstallRootKey({ backend: "file", configDir });
    // Arm a valid MAC-bound marker with the real root key, then corrupt the MAC.
    await markStorageEncryptionRequired(configDir, { backend: "file" });
    const marker = join(configDir, "keyring", "storage-encryption-required");
    writeFileSync(marker, readFileSync(marker, "utf8").replace("mac=", "mac=AAAA"));

    const r = await spawnGatewayExpectingExit(configDir, await freePort(), {
      OMNESIS_SECRET_STORE: "file",
    });
    expect(r.acceptedConnection).toBe(false);
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/failed integrity verification/i);
  }, 60_000);

  test("a present-but-unopenable root key (wrong passphrase) exits the process", async () => {
    const configDir = tmp();
    process.env.OMNESIS_SECRET_STORE = "passphrase";
    process.env.OMNESIS_KEYRING_PASSPHRASE = "initial passphrase";
    await ensureInstallRootKey({ backend: "passphrase", configDir });

    const r = await spawnGatewayExpectingExit(configDir, await freePort(), {
      OMNESIS_SECRET_STORE: "passphrase",
      OMNESIS_KEYRING_PASSPHRASE: "wrong passphrase",
    });
    expect(r.acceptedConnection).toBe(false);
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/cannot be read/i);
  }, 60_000);
});
