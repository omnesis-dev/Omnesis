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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  backupManifestSchema,
  gatewayStoreFiles,
  listBackups,
  prunePreUpdateBackups,
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
    expect(statSync(join(path, "token")).mode & 0o777).toBe(0o600);

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

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a copy that fails part-way leaves no backup behind",
    () => {
      const configDir = stoppedGateway();
      // Readable to stat and size, unreadable to copy: the store copies land,
      // then the config material fails.
      chmodSync(join(configDir, "token"), 0o000);
      try {
        expect(() =>
          writeOfflineBackup({
            configDir,
            stores: gatewayStoreFiles(configDir, { includeIndex: false, env: {} }),
            includeIndex: false,
            version: "9.9.0",
            purpose: "pre-update",
            statfs: roomy,
          }),
        ).toThrow(/EACCES/);
        expect(readdirSync(join(configDir, "backups"))).toEqual([]);
      } finally {
        chmodSync(join(configDir, "token"), 0o600);
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
