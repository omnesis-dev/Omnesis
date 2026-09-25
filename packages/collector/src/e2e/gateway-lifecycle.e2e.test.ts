// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One gateway per configuration directory, enforced before any store opens.
 *
 * A second gateway pointed at a live gateway's config dir — on another port,
 * so nothing but the directory lock can refuse it — must exit without
 * touching the stores, name the owner, and leave the first gateway serving
 * and writing. A replacement started while its predecessor drains waits for
 * the directory and takes it over; one started after a predecessor was
 * killed reclaims the stale lock.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GATEWAY_LOCK_FILE } from "@omnesis/core";
import { MultiCollectorHarness, getFreePort } from "./multi-collector-harness.js";
import { e2eTsxCommand } from "./gateway-env.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";

const REPO_ROOT = join(import.meta.dirname, "../../../..");

const schema = {
  tableName: "gateway_lifecycle_rows",
  displayName: "Gateway lifecycle rows",
  description: "Synthetic rows written across gateway hand-overs",
  columns: [
    { name: "id", type: "VARCHAR", description: "Row id" },
    { name: "value", type: "DOUBLE", description: "Value" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["id"], keyColumns: ["id"] },
};

interface SpawnedGateway {
  child: ChildProcess;
  output(): string;
  exited: Promise<number | null>;
}

/** Boot a gateway against the harness's stores, on `port`, the way the harness does. */
function spawnGateway(env: NodeJS.ProcessEnv, port: number, lockWaitMs: number): SpawnedGateway {
  const command = e2eTsxCommand("packages/gateway/src/index.ts");
  const child = spawn(command.command, command.args, {
    env: {
      ...env,
      OMNESIS_GATEWAY_PORT: String(port),
      OMNESIS_LOG_LEVEL: "info",
      OMNESIS_GATEWAY_LOCK_WAIT_MS: String(lockWaitMs),
    },
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  registerSubprocessGroup(child);
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += String(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => (output += String(chunk)));
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  return { child, output: () => output, exited };
}

/** The recorded owner, or null while no gateway holds the directory. */
function lockHolder(configDir: string): { pid: number } | null {
  try {
    return JSON.parse(readFileSync(join(configDir, GATEWAY_LOCK_FILE), "utf8")) as { pid: number };
  } catch {
    return null;
  }
}

function parentPid(pid: number): number | null {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
    const parent = Number.parseInt(out.trim(), 10);
    return Number.isFinite(parent) ? parent : null;
  } catch {
    return null;
  }
}

/**
 * The gateway is launched through the tsx loader, so the process that takes
 * the lock is a child of the PID the harness (or this test) spawned. A lock
 * belongs to a spawned gateway when its holder sits in that process's tree.
 */
function belongsTo(holderPid: number, rootPid: number): boolean {
  let pid: number | null = holderPid;
  for (let depth = 0; pid !== null && pid > 1 && depth < 8; depth += 1) {
    if (pid === rootPid) return true;
    pid = parentPid(pid);
  }
  return false;
}

async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe("gateway ownership of a config dir", () => {
  let harness: MultiCollectorHarness;

  const ingest = (id: string, value: number) =>
    harness.json("/analytics/ingest", {
      method: "POST",
      body: JSON.stringify({
        tableName: schema.tableName,
        sourceId: "synthetic:lifecycle@example.com",
        schema,
        records: [{ id, value }],
      }),
    });
  const count = async () =>
    (
      await harness.json<{ rows: unknown[][] }>("/analytics/sql", {
        method: "POST",
        body: JSON.stringify({ sql: `SELECT count(*) FROM ${schema.tableName}` }),
      })
    ).rows[0]![0];

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
  }, 120_000);

  afterAll(async () => {
    await harness?.destroy();
  });

  test("a duplicate gateway is refused before it opens a store, and the owner keeps writing", async () => {
    const configDir = harness.gatewayConfigDir;
    const lockPath = join(configDir, GATEWAY_LOCK_FILE);
    expect(existsSync(lockPath)).toBe(true);
    const owner = lockHolder(configDir)!;
    expect(belongsTo(owner.pid, harness.gatewayPid!)).toBe(true);
    await ingest("row-1", 1);

    const duplicate = spawnGateway(harness.gatewayLaunchEnv, await getFreePort(), 2_000);
    expect(await duplicate.exited).toBe(1);
    const output = duplicate.output();
    expect(output).toContain("still owns");
    expect(output).toContain("already owns this configuration directory");
    expect(output).toContain(`PID ${owner.pid}`);
    expect(output).not.toContain("Analytics DB opened");
    // The owner's lock survives the refused boot untouched.
    expect(lockHolder(configDir)).toMatchObject({ pid: owner.pid });

    expect((await fetch(`${harness.gatewayUrl}/health`)).status).toBe(200);
    await ingest("row-2", 2);
    expect(await count()).toBe(2);
  }, 120_000);

  test("a replacement started while the owner drains waits, then takes the directory over", async () => {
    const configDir = harness.gatewayConfigDir;
    const predecessor = harness.gatewayPid!;
    const owner = lockHolder(configDir)!;
    // What a supervisor's restart does: signal the old gateway's process group
    // and start the new one at once. The replacement must not open a store
    // until the old one has released them all — either it finds the directory
    // free already, or it says it is waiting and then takes over.
    process.kill(-predecessor, "SIGTERM");
    const replacement = spawnGateway(harness.gatewayLaunchEnv, harness.gatewayPort, 60_000);
    try {
      await waitFor(
        () => {
          const holder = lockHolder(configDir);
          return holder !== null && belongsTo(holder.pid, replacement.child.pid!);
        },
        90_000,
        "the replacement to take the lock",
      );
      const output = replacement.output();
      if (output.includes("still owns")) expect(output).toContain(`PID ${owner.pid}`);
      expect(output).not.toContain("already owns this configuration directory");
      await waitFor(
        () => replacement.output().includes("Analytics DB opened"),
        60_000,
        "the replacement to open the store",
      );
      await waitFor(
        () => existsSync(join(configDir, "token")),
        30_000,
        "the replacement to finish booting",
      );
      for (let attempt = 0; attempt < 300; attempt++) {
        try {
          if ((await fetch(`${harness.gatewayUrl}/health`)).status === 200) break;
        } catch {
          /* not listening yet */
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect((await fetch(`${harness.gatewayUrl}/health`)).status).toBe(200);
      expect(await count()).toBe(2);
    } finally {
      await killSubprocessGroup(replacement.child, { initialSignal: "SIGKILL" });
    }
    // The killed replacement left its lock behind for the next boot to find.
    expect(existsSync(join(configDir, GATEWAY_LOCK_FILE))).toBe(true);
  }, 180_000);

  test("a gateway booted after its predecessor was killed reclaims the stale lock", async () => {
    const configDir = harness.gatewayConfigDir;
    const stale = lockHolder(configDir)?.pid ?? null;
    await harness.restartGateway({ signal: "SIGKILL" });
    const holder = lockHolder(configDir)!;
    expect(belongsTo(holder.pid, harness.gatewayPid!)).toBe(true);
    expect(holder.pid).not.toBe(stale);
    expect((await fetch(`${harness.gatewayUrl}/health`)).status).toBe(200);
    expect(await count()).toBe(2);
  }, 120_000);
});
