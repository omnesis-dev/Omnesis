// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { inspectWindowsPrivatePathSync } from "./windows-private-file.js";
import {
  backupConfigCopyNames,
  backupManifestSchema,
  backupScopeEntries,
  backupScopeEntryFor,
  gatewayStoreFiles,
  listBackups,
  prunePreUpdateBackups,
  restoredDotEnv,
  writeOfflineBackup,
} from "./backup-layout.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-backup-layout-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const quiet = { info: () => {}, warn: () => {} };
const fixedClock = (iso: string) => () => new Date(iso);
const roomy = () => ({ bavail: 1_000_000_000, bsize: 4096 });

/** A stopped gateway's config dir: stores, their companions, and config material. */
function stoppedGateway(): string {
  const configDir = tmp();
  writeFileSync(join(configDir, "omnesis.db"), "main-store");
  writeFileSync(join(configDir, "omnesis.db-wal"), "uncheckpointed-pages");
  writeFileSync(join(configDir, "omnesis.db-shm"), "shared-memory");
  writeFileSync(join(configDir, "index.db"), "index-store");
  writeFileSync(join(configDir, "watch.db"), "watch-journal");
  writeFileSync(join(configDir, "analytics.db"), "analytics-store");
  writeFileSync(join(configDir, "analytics.db.wal"), "analytics-wal");
  writeFileSync(join(configDir, "omnesis.json"), '{"gateway":{"port":17600}}\n');
  writeFileSync(join(configDir, "token"), "token-envelope");
  mkdirSync(join(configDir, "keyring", "storage-keys"), { recursive: true });
  writeFileSync(join(configDir, "keyring", "storage-keys", "main-db.json"), "wrapped-key");
  mkdirSync(join(configDir, "models"), { recursive: true });
  writeFileSync(join(configDir, "models", "embedder.gguf"), "re-downloadable");
  mkdirSync(join(configDir, "provider-example", "account-one"), { recursive: true });
  writeFileSync(
    join(configDir, "provider-example", "account-one", "credentials.json"),
    '{"apiKey":"example"}',
  );
  return configDir;
}

describe("writeOfflineBackup", () => {
  test("copies the stores with their companions and the same config material as an online backup", () => {
    const configDir = stoppedGateway();
    const { path, files } = writeOfflineBackup({
      configDir,
      stores: gatewayStoreFiles(configDir, { includeIndex: false, env: {} }),
      includeIndex: false,
      version: "9.9.0",
      purpose: "pre-update",
      note: "pre-update 9.9.0 to v9.9.1",
      now: fixedClock("2026-03-14T09:12:05.000Z"),
      statfs: roomy,
    });

    expect(path).toBe(join(configDir, "backups", "2026-03-14T09-12-05"));
    expect(files.map((file) => file.name).sort()).toEqual(
      [
        "analytics.db",
        "analytics.db.wal",
        "keyring/storage-keys",
        "omnesis.db",
        "omnesis.db-shm",
        "omnesis.db-wal",
        "omnesis.json",
        "provider-example/account-one/credentials.json",
        "token",
        "watch.db",
      ].sort(),
    );
    // The index rebuilds from the document store, and models re-download.
    expect(existsSync(join(path, "index.db"))).toBe(false);
    expect(existsSync(join(path, "models"))).toBe(false);
    expect(readFileSync(join(path, "omnesis.db-wal"), "utf8")).toBe("uncheckpointed-pages");
    expect(readFileSync(join(path, "keyring", "storage-keys", "main-db.json"), "utf8")).toBe(
      "wrapped-key",
    );
    if (process.platform === "win32")
      expect(inspectWindowsPrivatePathSync(join(path, "token"), "file").private).toBe(true);
    else expect(statSync(join(path, "token")).mode & 0o777).toBe(0o600);

    const manifest = backupManifestSchema.parse(
      JSON.parse(readFileSync(join(path, "backup-manifest.json"), "utf8")),
    );
    expect(manifest).toMatchObject({
      version: "9.9.0",
      includeIndex: false,
      purpose: "pre-update",
      note: "pre-update 9.9.0 to v9.9.1",
    });
    // Stores are copied byte for byte, never re-encrypted as artifacts.
    expect(manifest.encryption).toBeUndefined();
    expect(listBackups(join(configDir, "backups")).map((backup) => backup.path)).toEqual([path]);
  });

  test("reads the stores from the paths the gateway's environment overrides name", () => {
    const configDir = tmp();
    const elsewhere = tmp();
    writeFileSync(join(elsewhere, "moved.db"), "moved-store");
    const stores = gatewayStoreFiles(configDir, {
      includeIndex: true,
      env: { OMNESIS_DB_PATH: join(elsewhere, "moved.db") },
    });
    expect(stores[0]).toEqual({ name: "omnesis.db", path: join(elsewhere, "moved.db") });
    expect(stores.map((store) => store.name)).toEqual([
      "omnesis.db",
      "index.db",
      "watch.db",
      "analytics.db",
    ]);
    const { path } = writeOfflineBackup({
      configDir,
      stores: stores.filter((store) => existsSync(store.path)),
      includeIndex: true,
      version: "9.9.0",
      purpose: "pre-update",
      statfs: roomy,
    });
    expect(readFileSync(join(path, "omnesis.db"), "utf8")).toBe("moved-store");
  });

  test("refuses before copying anything when the volume cannot hold the copy", () => {
    const configDir = stoppedGateway();
    expect(() =>
      writeOfflineBackup({
        configDir,
        stores: gatewayStoreFiles(configDir, { includeIndex: false, env: {} }),
        includeIndex: false,
        version: "9.9.0",
        purpose: "pre-update",
        statfs: () => ({ bavail: 1, bsize: 1 }),
      }),
    ).toThrow(/Not enough free disk space for a backup/);
    expect(readdirSync(join(configDir, "backups"))).toEqual([]);
  });

  test.skipIf(process.platform !== "win32" && process.getuid?.() === 0)(
    "a copy that fails part-way leaves no backup behind",
    () => {
      const configDir = stoppedGateway();
      // Readable to stat and size, unreadable to copy: the store copies land,
      // then the config material fails.
      const token = join(configDir, "token");
      let restoreRead: () => void;
      if (process.platform === "win32") {
        const system32 = join(process.env.SystemRoot!, "System32");
        const identity = execFileSync(
          join(system32, "whoami.exe"),
          ["/user", "/fo", "csv", "/nh"],
          { encoding: "utf8", timeout: 10_000 },
        );
        const sids = identity.match(/\bS-1-\d+(?:-\d+)+\b/gu);
        if (sids?.length !== 1) throw new Error("Fixture owner SID unavailable");
        const sid = `*${sids[0]}`;
        const acl = (args: string[]): void => {
          execFileSync(join(system32, "icacls.exe"), [token, ...args, "/Q"], {
            encoding: "utf8",
            timeout: 10_000,
          });
        };
        acl(["/deny", `${sid}:(RD)`]);
        restoreRead = () => acl(["/remove:d", sid]);
      } else {
        chmodSync(token, 0o000);
        restoreRead = () => chmodSync(token, 0o600);
      }
      try {
        // Windows backup privilege can let Node read through a deny DACL; the
        // native copy must still refuse it without publishing a partial backup.
        if (process.platform !== "win32") expect(() => readFileSync(token)).toThrow();
        const backup = () =>
          writeOfflineBackup({
            configDir,
            stores: gatewayStoreFiles(configDir, { includeIndex: false, env: {} }),
            includeIndex: false,
            version: "9.9.0",
            purpose: "pre-update",
            statfs: roomy,
          });
        if (process.platform === "win32")
          expect(backup).toThrow(expect.objectContaining({ code: "EPRIVATE" }));
        else expect(backup).toThrow(/EACCES/);
        expect(readdirSync(join(configDir, "backups"))).toEqual([]);
      } finally {
        restoreRead();
      }
    },
  );
});

describe("prunePreUpdateBackups", () => {
  test("an offline pre-update backup counts toward the same retention as an online one", () => {
    const configDir = stoppedGateway();
    const backupsDir = join(configDir, "backups");
    const take = (iso: string, purpose: "pre-update" | "operator") =>
      writeOfflineBackup({
        configDir,
        stores: gatewayStoreFiles(configDir, { includeIndex: false, env: {} }),
        includeIndex: false,
        version: "9.9.0",
        purpose,
        now: fixedClock(iso),
        statfs: roomy,
      }).path;
    const oldest = take("2026-03-10T09:00:00.000Z", "pre-update");
    const operator = take("2026-03-11T09:00:00.000Z", "operator");
    const middle = take("2026-03-12T09:00:00.000Z", "pre-update");
    const newest = take("2026-03-13T09:00:00.000Z", "pre-update");

    prunePreUpdateBackups(backupsDir, 2, newest, quiet);

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(operator)).toBe(true);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(newest)).toBe(true);
  });
});

describe("what a backup owns", () => {
  test("names each store, its companions, the config material and the derived index", () => {
    for (const name of [
      "omnesis.db",
      "omnesis.db-wal",
      "index.db-shm",
      "watch.db",
      "analytics.db.wal",
    ]) {
      expect(backupScopeEntryFor(name)).toEqual({ name, kind: "store" });
    }
    for (const name of [
      "index.usearch",
      "index.usearch.enc",
      "index-3.usearch",
      "index.usearch.corrupt-1",
    ]) {
      expect(backupScopeEntryFor(name)).toEqual({ name, kind: "derived" });
    }
    expect(backupScopeEntryFor("omnesis.json")).toEqual({ name: "omnesis.json", kind: "config" });
    expect(backupScopeEntryFor(".env")).toEqual({ name: ".env", kind: "config" });
    expect(backupScopeEntryFor("tls/cert.pem")).toEqual({ name: "tls", kind: "config" });
    expect(backupScopeEntryFor("sweeps/weekly/review.md")).toEqual({
      name: "sweeps",
      kind: "config",
    });
    expect(backupScopeEntryFor("keyring/storage-keys/main-db.json")).toEqual({
      name: "keyring/storage-keys",
      kind: "config",
    });
    expect(backupScopeEntryFor("keyring/recovery-envelope.json")?.kind).toBe("config");
    expect(backupScopeEntryFor("plaid-credentials.json")?.kind).toBe("config");
    expect(backupScopeEntryFor("provider-example/account-one/credentials.json")?.kind).toBe(
      "config",
    );
  });

  test("leaves everything the machine owns out", () => {
    for (const rel of [
      "backups/2026-01-02T03-04-05/omnesis.db",
      "models/embedder.gguf",
      "exports/export.jsonl",
      "logs/gateway.log",
      "keyring.pass",
      "keyring/passphrase/aW5zdGFsbC1yb290LWtleS12MQ.json",
      "keyring/omnesis/aW5zdGFsbC1yb290LWtleS12MQ.secret",
      "gateway.lock",
      "docker-compose.yml",
      "install-method",
      "shared-folders",
      "update-state.json",
      "collector/collector-token",
      "provider-example/account-one/cursor.json",
      "omnesis.db.bak",
      "index.db.backup",
    ]) {
      expect(backupScopeEntryFor(rel), rel).toBeNull();
    }
  });

  test("lists what a config dir holds of it, the same names a backup copies", () => {
    const configDir = stoppedGateway();
    writeFileSync(join(configDir, "index.usearch"), "graph");
    writeFileSync(join(configDir, "keyring.pass"), "machine passphrase");
    const entries = backupScopeEntries(configDir);
    expect(entries.filter((e) => e.kind === "config").map((e) => e.name)).toEqual(
      backupConfigCopyNames(configDir),
    );
    expect(entries.filter((e) => e.kind === "derived").map((e) => e.name)).toEqual([
      "index.usearch",
    ]);
    expect(
      entries
        .filter((e) => e.kind === "store")
        .map((e) => e.name)
        .sort(),
    ).toEqual(
      [
        "analytics.db",
        "analytics.db.wal",
        "index.db",
        "omnesis.db",
        "omnesis.db-shm",
        "omnesis.db-wal",
        "watch.db",
      ].sort(),
    );
    for (const entry of entries) expect(backupScopeEntryFor(entry.name), entry.name).toEqual(entry);
    expect(entries.some((e) => e.name.startsWith("models") || e.name === "keyring.pass")).toBe(
      false,
    );
  });

  test("a restored .env takes the machine's lines from the target and the rest from the backup", () => {
    const merged = restoredDotEnv(
      "# from the backup\nOMNESIS_IMAGE_TAG=0.1.0\nexport OMNESIS_EXPERIMENTAL=1\nOMNESIS_SECRET_STORE=file\n",
      "OMNESIS_IMAGE_TAG=0.2.0\nOMNESIS_LOG_LEVEL=debug\nOMNESIS_KEYRING_PASSPHRASE_FILE=/srv/example/keyring.pass\n",
    );
    expect(merged).toBe(
      "# from the backup\nexport OMNESIS_EXPERIMENTAL=1\nOMNESIS_IMAGE_TAG=0.2.0\nOMNESIS_KEYRING_PASSPHRASE_FILE=/srv/example/keyring.pass\n",
    );
    // No .env in the backup: only the machine's own lines survive.
    expect(restoredDotEnv(null, "OMNESIS_IMAGE_TAG=0.2.0\nOMNESIS_LOG_LEVEL=debug\n")).toBe(
      "OMNESIS_IMAGE_TAG=0.2.0\n",
    );
    expect(restoredDotEnv(null, "OMNESIS_LOG_LEVEL=debug\n")).toBeNull();
    expect(restoredDotEnv(null, null)).toBeNull();
    // A machine key only the backup has does not come back.
    expect(restoredDotEnv("OMNESIS_SECRET_STORE=passphrase\n", null)).toBeNull();
  });
});
