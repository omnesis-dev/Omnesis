// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Fail-closed boot E2E: the real gateway PROCESS must exit non-zero without
 * opening its stores or exposing corpus APIs when at-rest encryption cannot
 * be honored safely. A database-independent startup page may listen first;
 * it must never turn API health green or bypass storage/authentication gates.
 * The unit tests assert key resolution throws; this proves the production
 * entrypoint exits instead of falling back to a plaintext corpus.
 *
 * Two ways the invariant can break, each proven against a spawned gateway:
 *   - a tampered fail-closed marker         → "failed integrity verification"
 *   - a present root key that will not open → TLS key persistence refuses the passphrase
 */

import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { request as httpsRequest } from "node:https";
import { existsSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstallRootKey, markStorageEncryptionRequired } from "@omnesis/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { e2eGatewayEnv, e2eTsxCommand, gatewayBootBudgetMs } from "./gateway-env.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";
import type { ClientRequest } from "node:http";

const REPO_ROOT = join(import.meta.dirname, "../../../..");
const BOOT_BUDGET = gatewayBootBudgetMs();
const PROGRESS_PATH = "/.well-known/omnesis-startup";
const API_PATHS = ["/health", "/portal/api/session", "/admin/config", "/documents"] as const;

interface ObservedResponse {
  path: string;
  status: number;
  body: string;
  complete: boolean;
}

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
  responses: ObservedResponse[];
}

/**
 * Spawn the gateway entrypoint through the local tsx loader and resolve
 * once it exits, probing live HTTPS throughout to prove no corpus API becomes
 * available even if the static startup observer is already listening.
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
      OMNESIS_BIND: "127.0.0.1",
      OMNESIS_MDNS_DISABLE: "1",
      OMNESIS_PARENT_PID: String(process.pid),
      // Exercise this fixture's TLS material, never inherited certificate paths.
      OMNESIS_TLS_CERT: "",
      OMNESIS_TLS_KEY: "",
      OMNESIS_TLS_EXTRA_NAMES: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  registerSubprocessGroup(child);

  let output = "";
  let sawListener = false;
  const recordOutput = (chunk: Buffer): void => {
    output += chunk.toString();
    // Cumulative output handles a marker split across stdout chunks. Probe
    // immediately rather than missing a short warm-runtime startup window.
    if (!sawListener && output.includes("Startup page listening")) {
      sawListener = true;
      probeRound();
    }
  };
  child.stdout.on("data", recordOutput);
  child.stderr.on("data", recordOutput);

  const responses: ObservedResponse[] = [];
  const requests = new Set<ClientRequest>();
  let pendingRound: Promise<void> | undefined;
  let probeAgain = false;
  let probingStopped = false;
  const probe = (path: string): Promise<void> =>
    new Promise((resolve) => {
      let settled = false;
      const request = httpsRequest(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: "GET",
          agent: false,
          rejectUnauthorized: false,
          headers: {
            Accept: path === "/portal/" ? "text/html" : "application/json",
          },
        },
        (response) => {
          const observed = {
            path,
            status: response.statusCode!,
            body: "",
            complete: false,
          };
          // Record headers immediately: a forbidden 200 still counts if the
          // failing process closes the connection before its body finishes.
          responses.push(observed);
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            observed.body += chunk;
          });
          response.once("end", () => {
            observed.complete = true;
            finish();
          });
          response.once("error", finish);
          response.once("close", finish);
        },
      );
      const finish = (): void => {
        if (settled) return;
        settled = true;
        requests.delete(request);
        request.destroy();
        resolve();
      };
      requests.add(request);
      request.once("error", finish);
      request.once("close", finish);
      request.setTimeout(500, finish);
      request.end();
    });
  const probeRound = (): void => {
    if (probingStopped) return;
    // Never stack probe rounds on a slow handshake or a closing listener.
    // Retain one immediate follow-up if the listen marker arrives mid-round.
    if (pendingRound) {
      probeAgain = true;
      return;
    }
    pendingRound = Promise.all([...API_PATHS, "/portal/", PROGRESS_PATH].map(probe))
      .then(() => {})
      .finally(() => {
        pendingRound = undefined;
        if (probeAgain && !probingStopped) {
          probeAgain = false;
          probeRound();
        }
      });
  };
  probeRound();
  const poll = setInterval(probeRound, 100);

  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`gateway did not exit within the shared boot budget; output:\n${output}`));
      }, BOOT_BUDGET);
      child.once("close", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    probingStopped = true;
    clearInterval(poll);
    for (const request of requests) request.destroy();
    await pendingRound;
    await killSubprocessGroup(child);
  }
  return { code, output, responses };
}

/** The startup observer must never be confused with an available corpus. */
function expectStorageGateClosed(
  result: BootAttempt,
  configDir: string,
  expectedListener: "startup" | "tls-refused",
): void {
  expect(result.code).toBe(1);
  expect(result.output).toContain("Cannot start:");
  expect(result.output).not.toContain("Live storage is UNENCRYPTED");
  expect(result.output).not.toContain("Analytics DB opened");
  expect(result.output).not.toContain("Listening on https://");
  const apiResponses = result.responses.filter((response) =>
    API_PATHS.some((path) => path === response.path),
  );
  if (expectedListener === "startup") {
    // A real response proves this reached the startup listener. Requests
    // racing its fatal shutdown may finish as connection refusal instead.
    expect(result.output).toContain("Startup page listening");
    expect(apiResponses.length).toBeGreaterThan(0);
  } else {
    // TLS private keys are encrypted before HTTPS binds. Failure to unlock
    // the install root key must refuse TLS itself, rather than create a
    // plaintext private key just to offer a startup observer.
    expect(result.output).toContain("PassphraseMismatchError");
    expect(result.output).not.toContain("Startup page listening");
    expect(result.responses).toEqual([]);
    expect(existsSync(join(configDir, "tls", "key.pem"))).toBe(false);
    expect(existsSync(join(configDir, "tls", "cert.pem"))).toBe(false);
  }
  for (const response of apiResponses) {
    expect(response.status, response.path).toBe(503);
    if (response.complete) {
      expect(["GATEWAY_STARTING", "GATEWAY_SHUTTING_DOWN"]).toContain(
        JSON.parse(response.body).code,
      );
    }
  }
  for (const response of result.responses.filter((response) => response.path === PROGRESS_PATH)) {
    expect([200, 503]).toContain(response.status);
    if (response.status === 200 && response.complete)
      expect(JSON.parse(response.body).state).not.toBe("ready");
  }
  for (const response of result.responses.filter((response) => response.path === "/portal/")) {
    expect([200, 503]).toContain(response.status);
    if (response.status === 200 && response.complete)
      expect(response.body).toContain("<title>Starting up · Omnesis</title>");
  }
  // Configured stores are omnesis.db, index.db, analytics.db and watch.db.
  // Include nested paths and sidecars so another plaintext fallback cannot
  // escape the assertion by using a different filename or partial file.
  const stores = readdirSync(configDir, { recursive: true, encoding: "utf8" }).filter((name) =>
    /\.(?:db|sqlite)(?:-(?:wal|shm|journal))?$/.test(name),
  );
  expect(stores).toEqual([]);
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
  test(
    "a tampered fail-closed marker exits without exposing APIs or opening stores",
    async () => {
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
      expectStorageGateClosed(r, configDir, "startup");
      expect(r.output).toMatch(/failed integrity verification/i);
    },
    BOOT_BUDGET + 10_000,
  );

  test(
    "a wrong passphrase refuses TLS without binding HTTPS or opening stores",
    async () => {
      const configDir = tmp();
      process.env.OMNESIS_SECRET_STORE = "passphrase";
      process.env.OMNESIS_KEYRING_PASSPHRASE = "initial passphrase";
      await ensureInstallRootKey({ backend: "passphrase", configDir });

      const r = await spawnGatewayExpectingExit(configDir, await freePort(), {
        OMNESIS_SECRET_STORE: "passphrase",
        OMNESIS_KEYRING_PASSPHRASE: "wrong passphrase",
      });
      expectStorageGateClosed(r, configDir, "tls-refused");
      expect(r.output).toMatch(/keyring passphrase does not open the stored secret/i);
    },
    BOOT_BUDGET + 10_000,
  );
});
