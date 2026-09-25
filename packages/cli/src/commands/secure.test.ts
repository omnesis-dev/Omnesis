// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis secure` wizard coverage: the offline end-to-end flow against a real
 * temp config dir with the file secret-store backend (backup snapshot, root
 * key, escrow, secret-file migration, storage keys), dry-run inertness,
 * online-path delegation, idempotent re-runs, and rollback semantics.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  inspectInstallRootKey,
  inspectStorageKey,
  readSecretTextFile,
  storageEncryptionRequired,
} from "@omnesis/core";
import { runRollback, runSecure, type SecureDeps } from "./secure.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-secure-wizard-"));
  dirs.push(dir);
  return dir;
}

let priorSecretStore: string | undefined;
beforeEach(() => {
  priorSecretStore = process.env.OMNESIS_SECRET_STORE;
  process.env.OMNESIS_SECRET_STORE = "file";
});
afterEach(() => {
  if (priorSecretStore === undefined) delete process.env.OMNESIS_SECRET_STORE;
  else process.env.OMNESIS_SECRET_STORE = priorSecretStore;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeSqliteDb(path: string, values: string[]): void {
  const db = new Database(path);
  db.exec("CREATE TABLE items (val TEXT)");
  const insert = db.prepare("INSERT INTO items (val) VALUES (?)");
  for (const v of values) insert.run(v);
  db.close();
}

function makeDeps(configDir: string, overrides: Partial<SecureDeps> = {}): SecureDeps {
  return {
    configDir,
    backend: "file",
    gatewayHealthy: async () => false,
    onlineBackup: vi.fn(async () => {}),
    restartService: vi.fn(async () => "restarted" as const),
    now: () => new Date("2026-06-01T10:00:00.000Z"),
    log: () => {},
    ...overrides,
  };
}

describe("runSecure — offline flow (gateway stopped)", () => {
  test("takes a snapshot, mints key + escrow + storage keys, migrates secrets", async () => {
    const configDir = tmp();
    makeSqliteDb(join(configDir, "omnesis.db"), ["alpha"]);
    writeFileSync(join(configDir, "token"), "omn_fake_admin_token");

    const summary = await runSecure(makeDeps(configDir), { dryRun: false, skipBackup: false });

    // Offline snapshot with a restore-compatible manifest.
    expect(summary.backupDir).toBeTruthy();
    const backupDir = summary.backupDir ?? "";
    expect(existsSync(join(backupDir, "omnesis.db"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(backupDir, "backup-manifest.json"), "utf8")) as {
      note?: string;
      files: Array<{ name: string }>;
    };
    expect(manifest.note).toBe("pre-secure");
    expect(manifest.files.map((f) => f.name)).toContain("omnesis.db");

    // Root key + escrow + storage keys + markers.
    const root = await inspectInstallRootKey({ backend: "file", configDir });
    expect(root.valid).toBe(true);
    expect(summary.recoveryCode).toBeTruthy();
    expect(existsSync(join(configDir, "keyring", "recovery-envelope.json"))).toBe(true);
    expect(storageEncryptionRequired(configDir)).toBe(true);
    await expect(
      inspectStorageKey("main-db", { backend: "file", configDir }),
    ).resolves.toMatchObject({ present: true, valid: true });

    // The token secret file was encrypted in place and still reads back.
    const raw = readFileSync(join(configDir, "token"), "utf8");
    expect(raw).not.toContain("omn_fake_admin_token");
    await expect(readSecretTextFile(join(configDir, "token"), { configDir })).resolves.toBe(
      "omn_fake_admin_token",
    );

    // Wizard state recorded for --rollback; restart is a named manual action.
    expect(existsSync(join(configDir, "keyring", "secure-wizard.json"))).toBe(true);
    const restart = summary.steps.find((s) => s.id === "restart");
    expect(restart?.status).toBe("action-required");
  });

  test("--dry-run changes nothing", async () => {
    const configDir = tmp();
    makeSqliteDb(join(configDir, "omnesis.db"), ["alpha"]);

    const summary = await runSecure(makeDeps(configDir), { dryRun: true, skipBackup: false });

    expect(summary.steps.every((s) => s.status === "planned" || s.status === "skipped")).toBe(true);
    expect(existsSync(join(configDir, "keyring"))).toBe(false);
    expect(existsSync(join(configDir, "backups"))).toBe(false);
    const root = await inspectInstallRootKey({ backend: "file", configDir });
    expect(root.present).toBe(false);
  });

  test("--skip-backup skips only the snapshot", async () => {
    const configDir = tmp();
    const summary = await runSecure(makeDeps(configDir), { dryRun: false, skipBackup: true });
    expect(existsSync(join(configDir, "backups"))).toBe(false);
    expect(summary.steps.find((s) => s.id === "backup")?.status).toBe("skipped");
    expect(summary.recoveryCode).toBeTruthy();
  });

  test("a second run is idempotent and skips completed steps", async () => {
    const configDir = tmp();
    makeSqliteDb(join(configDir, "omnesis.db"), ["alpha"]);
    const first = await runSecure(makeDeps(configDir), { dryRun: false, skipBackup: false });
    const firstCode = first.recoveryCode;

    // Simulate the gateway having encrypted the corpus on its restart.
    writeFileSync(join(configDir, "omnesis.db"), Buffer.from("not-a-plaintext-sqlite-header!"));

    const second = await runSecure(makeDeps(configDir), { dryRun: false, skipBackup: true });
    expect(second.recoveryCode).toBeUndefined();
    expect(firstCode).toBeTruthy();
    expect(second.steps.find((s) => s.id === "root-key")?.status).toBe("skipped");
    expect(second.steps.find((s) => s.id === "escrow")?.status).toBe("skipped");
    expect(second.steps.find((s) => s.id === "storage-keys")?.status).toBe("skipped");
    expect(second.steps.find((s) => s.id === "restart")?.status).toBe("skipped");
  });
});

describe("runSecure — online flow (gateway running)", () => {
  test("delegates the backup to the gateway and restarts the service", async () => {
    const configDir = tmp();
    // A non-plaintext header simulates the post-restart encrypted corpus.
    writeFileSync(join(configDir, "omnesis.db"), Buffer.from("not-a-plaintext-sqlite-header!"));
    const onlineBackup = vi.fn(async () => {});
    const restartService = vi.fn(async () => "restarted" as const);
    const deps = makeDeps(configDir, {
      gatewayHealthy: async () => true,
      onlineBackup,
      restartService,
    });

    const summary = await runSecure(deps, { dryRun: false, skipBackup: false });

    expect(onlineBackup).toHaveBeenCalledWith("pre-secure");
    expect(restartService).toHaveBeenCalledTimes(1);
    expect(summary.steps.find((s) => s.id === "restart")?.status).toBe("done");
    // No offline snapshot dir when the gateway takes the backup.
    expect(existsSync(join(configDir, "backups"))).toBe(false);
  });

  test("reports action-required when no managed service exists", async () => {
    const configDir = tmp();
    const deps = makeDeps(configDir, {
      gatewayHealthy: async () => true,
      restartService: vi.fn(async () => "not-installed" as const),
    });
    const summary = await runSecure(deps, { dryRun: false, skipBackup: true });
    expect(summary.steps.find((s) => s.id === "restart")?.status).toBe("action-required");
  });
});

describe("runRollback", () => {
  test("restores the recorded snapshot when the gateway is stopped", async () => {
    const configDir = tmp();
    makeSqliteDb(join(configDir, "omnesis.db"), ["alpha", "beta"]);
    await runSecure(makeDeps(configDir), { dryRun: false, skipBackup: false });

    // The migration "corrupted" the corpus; roll back.
    writeFileSync(join(configDir, "omnesis.db"), "corrupted!");
    await runRollback(makeDeps(configDir), { yes: true });

    const db = new Database(join(configDir, "omnesis.db"), { readonly: true });
    const rows = db.prepare("SELECT val FROM items ORDER BY val").all() as Array<{ val: string }>;
    db.close();
    expect(rows.map((r) => r.val)).toEqual(["alpha", "beta"]);
  });

  test("refuses without --yes and while the gateway is running", async () => {
    const configDir = tmp();
    makeSqliteDb(join(configDir, "omnesis.db"), ["alpha"]);
    await runSecure(makeDeps(configDir), { dryRun: false, skipBackup: false });

    await expect(runRollback(makeDeps(configDir), { yes: false })).rejects.toThrow(/--yes/);
    await expect(
      runRollback(makeDeps(configDir, { gatewayHealthy: async () => true }), { yes: true }),
    ).rejects.toThrow(/stop it/i);
  });

  test("errors actionably when no snapshot was recorded", async () => {
    const configDir = tmp();
    await expect(runRollback(makeDeps(configDir), { yes: true })).rejects.toThrow(
      /No pre-secure snapshot/,
    );
  });
});

describe("runSecure — output routing", () => {
  test("the step narration goes through deps.log, so --json can suppress it", async () => {
    const configDir = tmp();
    makeSqliteDb(join(configDir, "omnesis.db"), ["alpha"]);
    const lines: string[] = [];
    await runSecure(makeDeps(configDir, { log: (l) => lines.push(l) }), {
      dryRun: true,
      skipBackup: false,
    });
    // Every human step line is routed through deps.log (which the command
    // replaces with a no-op under --json), never written directly to stdout.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("Pre-migration backup"))).toBe(true);
  });
});

describe("runSecure — host role", () => {
  test("a collector-only host mints its own keys and restarts the collector, never the gateway", async () => {
    const configDir = tmp();
    // The collector's pairing token is what marks this directory as a
    // collector's; there is no gateway database beside it.
    writeFileSync(join(configDir, "collector-token"), "omn_fake_collector_token");
    const gatewayHealthy = vi.fn(async () => true);
    const restartService = vi.fn(async () => "restarted" as const);
    const summary = await runSecure(makeDeps(configDir, { gatewayHealthy, restartService }), {
      dryRun: false,
      skipBackup: false,
    });
    const step = (id: string) => summary.steps.find((entry) => entry.id === id);
    expect(step("backup")).toMatchObject({
      status: "skipped",
      detail: expect.stringContaining("no gateway databases on this host"),
    });
    // A remote gateway's health is not this host's evidence, and it is never
    // restarted from here.
    expect(gatewayHealthy).not.toHaveBeenCalled();
    expect(restartService).toHaveBeenCalledTimes(1);
    expect(restartService).toHaveBeenCalledWith("collector");
    expect(step("restart")).toBeUndefined();
    expect(step("collector-restart")).toMatchObject({ status: "done" });
    for (const keyName of ["whatsapp-store", "imessage-transcripts"] as const) {
      await expect(inspectStorageKey(keyName, { configDir })).resolves.toMatchObject({
        present: true,
        valid: true,
      });
    }
    await expect(inspectStorageKey("main-db", { configDir })).resolves.toMatchObject({
      present: false,
    });
  });

  test("a collector-only dry run names the collector's keys and restart", async () => {
    const configDir = tmp();
    writeFileSync(join(configDir, "collector-token"), "omn_fake_collector_token");
    const restartService = vi.fn(async () => "restarted" as const);
    const summary = await runSecure(makeDeps(configDir, { restartService }), {
      dryRun: true,
      skipBackup: false,
    });
    const step = (id: string) => summary.steps.find((entry) => entry.id === id);
    expect(step("storage-keys")).toMatchObject({
      status: "planned",
      detail: "mint wrapped keys for whatsapp-store, imessage-transcripts",
    });
    expect(step("collector-restart")).toMatchObject({ status: "planned" });
    expect(step("restart")).toBeUndefined();
    expect(restartService).not.toHaveBeenCalled();
  });

  test("a host running both restarts the gateway and then the collector", async () => {
    const configDir = tmp();
    makeSqliteDb(join(configDir, "omnesis.db"), ["alpha"]);
    writeFileSync(join(configDir, "collector-token"), "omn_fake_collector_token");
    const restartService = vi.fn(async () => "not-installed" as const);
    const summary = await runSecure(makeDeps(configDir, { restartService }), {
      dryRun: false,
      skipBackup: true,
    });
    const ids = summary.steps.map((entry) => entry.id);
    expect(ids.indexOf("restart")).toBeGreaterThan(-1);
    expect(ids.indexOf("collector-restart")).toBeGreaterThan(ids.indexOf("restart"));
    expect(summary.steps.find((entry) => entry.id === "collector-restart")).toMatchObject({
      status: "action-required",
      detail: expect.stringContaining("omnesis collector run"),
    });
  });
});
