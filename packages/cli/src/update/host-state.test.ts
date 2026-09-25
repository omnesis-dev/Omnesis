// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  GATEWAY_LOCK_FILE,
  gatewayStoreFiles,
  listBackups,
  writeOfflineBackup,
} from "@omnesis/core";
import {
  completedSourceApplyState,
  serializeUpdateApplyState,
  UPDATE_STATE_FILE,
} from "./detect.js";
import {
  gatewayRunning,
  gatewayStartedAt,
  preUpdateRetention,
  sourceInstalledAt,
  takeOfflineGatewayBackup,
} from "./host-state.js";

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-host-state-"));
  dirs.push(dir);
  return dir;
}

const quiet = { info: () => {}, warn: () => {} };

function stoppedGateway(): string {
  const configDir = tmp();
  writeFileSync(join(configDir, "omnesis.db"), "main-store");
  writeFileSync(join(configDir, "omnesis.json"), '{"gateway":{"port":17600}}\n');
  return configDir;
}

/** Record `pid` as this config directory's gateway, the way a gateway does. */
function writeGatewayLock(configDir: string, pid: number, startedAt: string): void {
  writeFileSync(
    join(configDir, GATEWAY_LOCK_FILE),
    `${JSON.stringify({ pid, processStart: null, hostname: hostname(), startedAt })}\n`,
  );
}

const take = (configDir: string, log = quiet) =>
  takeOfflineGatewayBackup({
    configDir,
    note: "pre-update 9.9.0 to v9.9.1",
    purpose: "pre-update",
    version: "9.9.0",
    env: {},
    log,
  });

describe("takeOfflineGatewayBackup", () => {
  test("a gateway that never created its document store has nothing to copy", async () => {
    const configDir = tmp();
    await expect(take(configDir)).resolves.toEqual({ kind: "nothing-to-copy" });
    expect(existsSync(join(configDir, "backups"))).toBe(false);
  });

  test("copies a stopped gateway's stores and gives the gateway lock back", async () => {
    const configDir = stoppedGateway();
    const outcome = await take(configDir);
    expect(outcome.kind).toBe("copied");
    expect(listBackups(join(configDir, "backups"))).toMatchObject([
      { purpose: "pre-update", version: "9.9.0", note: "pre-update 9.9.0 to v9.9.1" },
    ]);
    // Held for the length of the copy, so no gateway starts under it, and
    // released after, so the next one can.
    expect(existsSync(join(configDir, GATEWAY_LOCK_FILE))).toBe(false);
  });

  test("a gateway holding the lock is left to take the backup through its API", async () => {
    const configDir = stoppedGateway();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    children.push(child);
    const startedAt = "2026-03-14T09:00:00.000Z";
    writeGatewayLock(configDir, child.pid!, startedAt);

    expect(gatewayRunning(configDir)).toBe(true);
    expect(gatewayStartedAt(configDir)).toBe(Date.parse(startedAt));
    await expect(take(configDir)).resolves.toEqual({ kind: "gateway-running" });
    expect(listBackups(join(configDir, "backups"))).toEqual([]);
  });

  test("a lock left by a gateway that died does not block the copy", async () => {
    const configDir = stoppedGateway();
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(child, "exit");
    writeGatewayLock(configDir, child.pid!, "2026-03-14T09:00:00.000Z");

    expect(gatewayRunning(configDir)).toBe(false);
    expect(gatewayStartedAt(configDir)).toBeNull();
    expect((await take(configDir)).kind).toBe("copied");
  });

  test("prunes earlier pre-update backups to the configured count", async () => {
    const configDir = stoppedGateway();
    writeFileSync(join(configDir, "omnesis.json"), '{"backupRetention":{"preUpdateCount":1}}\n');
    const earlier = writeOfflineBackup({
      configDir,
      stores: gatewayStoreFiles(configDir, { includeIndex: false, env: {} }),
      includeIndex: false,
      version: "9.8.0",
      purpose: "pre-update",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    }).path;
    const outcome = await take(configDir);
    expect(outcome.kind).toBe("copied");
    expect(existsSync(earlier)).toBe(false);
  });

  test("keeps every earlier backup when the configured count cannot be read", async () => {
    const configDir = stoppedGateway();
    writeFileSync(join(configDir, "omnesis.json"), "{ not json");
    const earlier = writeOfflineBackup({
      configDir,
      stores: gatewayStoreFiles(configDir, { includeIndex: false, env: {} }),
      includeIndex: false,
      version: "9.8.0",
      purpose: "pre-update",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    }).path;
    const warn = vi.fn();
    expect((await take(configDir, { info: () => {}, warn })).kind).toBe("copied");
    expect(existsSync(earlier)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("preUpdateCount could not be read"));
  });
});

describe("preUpdateRetention", () => {
  test("the default without a config file or without the key", () => {
    expect(preUpdateRetention(tmp())).toBe(2);
    const configDir = tmp();
    writeFileSync(join(configDir, "omnesis.json"), '{"gateway":{}}');
    expect(preUpdateRetention(configDir)).toBe(2);
  });

  test("the configured count, zero included", () => {
    const configDir = tmp();
    writeFileSync(join(configDir, "omnesis.json"), '{"backupRetention":{"preUpdateCount":0}}');
    expect(preUpdateRetention(configDir)).toBe(0);
  });

  test("null for a count it cannot trust", () => {
    const configDir = tmp();
    for (const text of [
      '{"backupRetention":{"preUpdateCount":"two"}}',
      "{",
      '{"backupRetention":{"preUpdateCount":-1}}',
    ]) {
      writeFileSync(join(configDir, "omnesis.json"), text);
      expect(preUpdateRetention(configDir)).toBeNull();
    }
  });
});

describe("sourceInstalledAt", () => {
  const rootDir = "/home/dev/omnesis";
  const commit = "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";

  test("is when the completion record for this checkout was written", () => {
    const configDir = tmp();
    const path = join(configDir, UPDATE_STATE_FILE);
    writeFileSync(path, serializeUpdateApplyState(completedSourceApplyState(rootDir, commit)));
    const written = new Date("2026-03-14T09:12:05.000Z");
    utimesSync(path, written, written);
    expect(sourceInstalledAt(configDir, rootDir)).toBe(written.getTime());
  });

  test("is unknown for another checkout, an unfinished apply, or no record", () => {
    const configDir = tmp();
    const path = join(configDir, UPDATE_STATE_FILE);
    expect(sourceInstalledAt(configDir, rootDir)).toBeNull();
    writeFileSync(path, serializeUpdateApplyState(completedSourceApplyState("/elsewhere", commit)));
    expect(sourceInstalledAt(configDir, rootDir)).toBeNull();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        method: "source",
        rootDir,
        phase: "applying",
        targetCommit: commit,
        lastCompletedCommit: commit,
      }),
    );
    expect(sourceInstalledAt(configDir, rootDir)).toBeNull();
  });
});
