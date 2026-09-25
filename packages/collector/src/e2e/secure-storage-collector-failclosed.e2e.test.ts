// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Fail-closed boot E2E for the collector PROCESS: when live-storage
 * encryption is armed on its host but the root key cannot be read, the
 * collector must exit non-zero before it pairs or syncs anything, naming
 * the remedy — not run on and fail one provider store at a time, and never
 * open a store plaintext. The unit tests assert the readiness resolver
 * throws; this asserts the boot wiring in `main.ts` turns that throw into a
 * dead process.
 *
 * The complementary path is proven as well: a host with a root key and no
 * keys yet mints its own before doing anything else, so a fresh remote
 * collector never depends on a gateway boot for its keys.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureInstallRootKey,
  inspectStorageKey,
  markStorageEncryptionRequired,
  storageKeyNamesForHost,
} from "@omnesis/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { e2eTsxCommand } from "./gateway-env.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";

const REPO_ROOT = join(import.meta.dirname, "../../../..");

interface BootAttempt {
  /** Null when the collector was stopped by the test after `until` matched. */
  code: number | null;
  output: string;
}

/**
 * Spawn the collector entrypoint through the local tsx loader and resolve
 * when it exits, or as soon as its output matches `until`. The gateway URL
 * points at a closed port, and a collector that gets past its storage check
 * waits for that gateway indefinitely, so a boot that is expected to go on
 * has to be stopped by the test once it has shown what it needed to.
 */
async function spawnCollector(
  configDir: string,
  extraEnv: Record<string, string>,
  until?: RegExp,
): Promise<BootAttempt> {
  const collectorCommand = e2eTsxCommand("packages/collector/src/main.ts");
  const child = spawn(collectorCommand.command, collectorCommand.args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      OMNESIS_CONFIG_DIR: configDir,
      OMNESIS_GATEWAY_URL: "https://127.0.0.1:1",
      OMNESIS_MDNS_DISABLE: "1",
      OMNESIS_LOG_LEVEL: "info",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  registerSubprocessGroup(child);
  let output = "";
  try {
    return await new Promise<BootAttempt>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`collector did not exit within 60s; output:\n${output}`));
      }, 60_000);
      const onData = (b: Buffer) => {
        output += b.toString();
        if (until?.test(output)) {
          clearTimeout(timer);
          resolve({ code: null, output });
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve({ code: exitCode, output });
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    await killSubprocessGroup(child);
  }
}

const dirs: string[] = [];

let priorSecretStore: string | undefined;

// The runner's own keyring calls use the file backend inside the temp
// directory, never the developer's OS keyring.
beforeEach(() => {
  priorSecretStore = process.env.OMNESIS_SECRET_STORE;
  process.env.OMNESIS_SECRET_STORE = "file";
});

afterEach(() => {
  if (priorSecretStore === undefined) delete process.env.OMNESIS_SECRET_STORE;
  else process.env.OMNESIS_SECRET_STORE = priorSecretStore;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-collector-failclosed-"));
  dirs.push(dir);
  return dir;
}

describe("collector storage encryption at boot", () => {
  test("armed encryption without a readable root key stops the collector before pairing", async () => {
    const configDir = tempConfigDir();
    await markStorageEncryptionRequired(configDir, { backend: "file" });

    const attempt = await spawnCollector(configDir, { OMNESIS_SECRET_STORE: "file" });
    expect(attempt.code).toBe(1);
    expect(attempt.output).toMatch(/Cannot start: Omnesis live storage encryption is required/u);
    // It never got as far as the gateway.
    expect(attempt.output).not.toMatch(/Waiting for gateway/u);
    for (const keyName of storageKeyNamesForHost("collector")) {
      await expect(inspectStorageKey(keyName, { configDir })).resolves.toMatchObject({
        present: false,
      });
    }
  }, 90_000);

  test("a host with a root key mints the collector's keys before anything else", async () => {
    const configDir = tempConfigDir();
    await ensureInstallRootKey({ backend: "file", configDir });

    const attempt = await spawnCollector(
      configDir,
      { OMNESIS_SECRET_STORE: "file" },
      /Waiting for gateway/u,
    );
    expect(attempt.output).toMatch(
      /Live storage encryption enabled for the collector's provider stores.*created whatsapp-store, imessage-transcripts/u,
    );
    // Minted before the first gateway contact, which is what a remote
    // collector's first sync depends on.
    expect(attempt.output.indexOf("Live storage encryption enabled")).toBeLessThan(
      attempt.output.indexOf("Waiting for gateway"),
    );
    for (const keyName of storageKeyNamesForHost("collector")) {
      await expect(inspectStorageKey(keyName, { configDir })).resolves.toMatchObject({
        present: true,
        valid: true,
        encrypted: true,
      });
    }
  }, 90_000);
});
