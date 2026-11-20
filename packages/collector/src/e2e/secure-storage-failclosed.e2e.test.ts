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
const PROBE_PATHS = [...API_PATHS, "/portal/", PROGRESS_PATH] as const;
/** Holds the gateway's marker read; written by `secure-marker-read-hold.mjs`. */
const MARKER_READ_HOLD = new URL("./secure-marker-read-hold.mjs", import.meta.url).href;
const MARKER_READ_HELD = "secure-marker-read-hold: held";

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
  /** One answer per probe path, taken while the marker read was held. */
  held: ObservedResponse[];
  /** Everything the background probe saw from spawn to exit. */
  responses: ObservedResponse[];
}

/**
 * Spawn the gateway entrypoint through the local tsx loader and resolve
 * once it exits, probing live HTTPS throughout to prove no corpus API becomes
 * available even if the static startup observer is already listening.
 *
 * With `holdMarkerRead`, the gateway's read of that marker waits until every
 * probe path has answered once. The startup listener cannot answer while the
 * main thread evaluates the runtime import, and the gateway exits within
 * milliseconds of reading a tampered marker, so without the hold the listener
 * may never get a turn to answer at all.
 */
async function spawnGatewayExpectingExit(
  configDir: string,
  port: number,
  extraEnv: Record<string, string>,
  holdMarkerRead?: string,
): Promise<BootAttempt> {
  const gatewayCommand = e2eTsxCommand("packages/gateway/src/index.ts");
  const args = holdMarkerRead
    ? ["--import", MARKER_READ_HOLD, ...gatewayCommand.args]
    : gatewayCommand.args;
  const child = spawn(gatewayCommand.command, args, {
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
      ...(holdMarkerRead ? { OMNESIS_E2E_HOLD_MARKER_READ: holdMarkerRead } : {}),
    },
    // Closing stdin releases a held marker read.
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  registerSubprocessGroup(child);
  // A gateway that already exited cannot take the release; that is not an error.
  child.stdin.on("error", () => {});

  let output = "";
  let sawListener = false;
  let heldRound: Promise<void> | undefined;
  const held: ObservedResponse[] = [];
  const recordOutput = (chunk: Buffer): void => {
    output += chunk.toString();
    // Cumulative output handles a marker split across stdout chunks. Probe
    // immediately rather than missing a short warm-runtime startup window.
    if (!sawListener && output.includes("Startup page listening")) {
      sawListener = true;
      probeRound();
    }
    if (!heldRound && output.includes(MARKER_READ_HELD)) {
      // No client timeout: the gateway cannot pass the held read, so each
      // probe ends with an answer, a connection error, or the gateway's exit.
      heldRound = Promise.all(PROBE_PATHS.map((path) => probe(path, held, false))).then(() => {
        child.stdin.end();
      });
    }
  };
  child.stdout.on("data", recordOutput);
  child.stderr.on("data", recordOutput);

  const responses: ObservedResponse[] = [];
  const requests = new Set<ClientRequest>();
  let pendingRound: Promise<void> | undefined;
  let probeAgain = false;
  let probingStopped = false;
  const probe = (path: string, into = responses, timeout = true): Promise<void> =>
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
          into.push(observed);
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
      if (timeout) request.setTimeout(500, finish);
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
    pendingRound = Promise.all(PROBE_PATHS.map((path) => probe(path)))
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
    await heldRound;
    await killSubprocessGroup(child);
  }
  return { code, output, held, responses };
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
  const everyResponse = [...result.held, ...result.responses];
  const apiResponses = everyResponse.filter((response) =>
    API_PATHS.some((path) => path === response.path),
  );
  if (expectedListener === "startup") {
    // While storage encryption is still being verified, the startup listener
    // answers every path, and every API refuses as starting. The background
    // probe then covers the rest of the gateway's life up to its exit.
    expect(result.output).toContain("Startup page listening");
    expect(result.output).toContain(MARKER_READ_HELD);
    const held = new Map(result.held.map((response) => [response.path, response]));
    expect([...held.keys()].sort()).toEqual([...PROBE_PATHS].sort());
    for (const path of API_PATHS) {
      expect(held.get(path), path).toMatchObject({ status: 503, complete: true });
      expect(JSON.parse(held.get(path)!.body).code, path).toBe("GATEWAY_STARTING");
    }
    const progress = held.get(PROGRESS_PATH)!;
    expect(progress).toMatchObject({ status: 200, complete: true });
    const snapshot = JSON.parse(progress.body) as {
      state: string;
      steps: Array<{ id: string; state: string }>;
    };
    expect(snapshot.state).toBe("starting");
    expect(snapshot.steps.find((step) => step.id === "storage")?.state).toBe("running");
    expect(held.get("/portal/")).toMatchObject({ status: 200, complete: true });
  } else {
    // TLS private keys are encrypted before HTTPS binds. Failure to unlock
    // the install root key must refuse TLS itself, rather than create a
    // plaintext private key just to offer a startup observer.
    expect(result.output).toContain("PassphraseMismatchError");
    expect(result.output).not.toContain("Startup page listening");
    expect(everyResponse).toEqual([]);
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
  for (const response of everyResponse.filter((response) => response.path === PROGRESS_PATH)) {
    expect([200, 503]).toContain(response.status);
    if (response.status === 200 && response.complete)
      expect(JSON.parse(response.body).state).not.toBe("ready");
  }
  for (const response of everyResponse.filter((response) => response.path === "/portal/")) {
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

      const r = await spawnGatewayExpectingExit(
        configDir,
        await freePort(),
        { OMNESIS_SECRET_STORE: "file" },
        marker,
      );
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
