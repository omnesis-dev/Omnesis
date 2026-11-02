// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis restore` round-trip coverage: build a small encrypted backup dir
 * (mimicking the online BackupService output — `.enc` artifacts + wrapped
 * storage keys + markers + a bundled recovery envelope) under a `file`-backend
 * root key, then restore it two ways: with the root key already in the target
 * keyring, and reconstituted from the recovery code on a keyring-less target.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import {
  acquireGatewayLock,
  createRecoveryEnvelope,
  encryptArtifactFileInPlace,
  ensureInstallRootKey,
  ensureStorageKey,
  generateRecoveryCode,
  isEncryptedArtifactFile,
  readInstallRootKey,
  writeInstallRootKey,
} from "@omnesis/core";
import { takeOfflineGatewayBackup } from "../update/host-state.js";
import { restore } from "./restore.js";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeSqliteDb(path: string, values: string[]): void {
  const db = new Database(path);
  db.exec("CREATE TABLE items (val TEXT)");
  const insert = db.prepare("INSERT INTO items (val) VALUES (?)");
  for (const v of values) insert.run(v);
  db.close();
}

function allFilesUnder(root: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...allFilesUnder(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function readSqliteValues(path: string): string[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare<[], { val: string }>("SELECT val FROM items ORDER BY val")
      .all()
      .map((r) => r.val);
  } finally {
    db.close();
  }
}

interface Fixture {
  backupDir: string;
  rootKey: string;
  recoveryCode: string;
}

/** Build an encrypted backup directory + return the root key and recovery code. */
async function buildEncryptedBackup(): Promise<Fixture> {
  const srcConfig = tmp("omnesis-restore-src-");
  await ensureInstallRootKey({ backend: "file", configDir: srcConfig });
  const rootKey = await readInstallRootKey({ backend: "file", configDir: srcConfig });
  if (!rootKey) throw new Error("expected a root key");
  await ensureStorageKey("main-db", { backend: "file", configDir: srcConfig });

  const backupDir = tmp("omnesis-restore-backup-");

  // Write a file into the backup dir then wrap it as an encrypted artifact,
  // exactly as BackupService does (the plaintext source is consumed).
  const encFile = async (rel: string, content: string | Buffer): Promise<void> => {
    const path = join(backupDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    await encryptArtifactFileInPlace(path, {
      backend: "file",
      configDir: srcConfig,
      scope: `backup:test:${rel}`,
    });
  };

  const dbPath = join(backupDir, "omnesis.db");
  makeSqliteDb(dbPath, ["alpha", "beta"]);
  await encryptArtifactFileInPlace(dbPath, {
    backend: "file",
    configDir: srcConfig,
    scope: "backup:test:omnesis.db",
  });

  await encFile("omnesis.json", JSON.stringify({ sources: [] }));
  await encFile("token", "fake-admin-token");
  // The encrypted full manifest is backup metadata — restore must NOT inflate it.
  await encFile("backup-manifest.full.json", JSON.stringify({ note: "pre-upgrade" }));
  await encFile(
    "keyring/storage-keys/main-db.json",
    readFileSync(join(srcConfig, "keyring", "storage-keys", "main-db.json")),
  );
  await encFile("keyring/storage-encryption-required", "omnesis.storage-encryption.required.v1\n");

  // The recovery envelope is bundled UNENCRYPTED (root-key-independent).
  const recoveryCode = generateRecoveryCode();
  const envelope = createRecoveryEnvelope(rootKey, recoveryCode);
  mkdirSync(join(backupDir, "keyring"), { recursive: true });
  writeFileSync(
    join(backupDir, "keyring", "recovery-envelope.json"),
    `${JSON.stringify(envelope, null, 2)}\n`,
  );

  writeFileSync(
    join(backupDir, "backup-manifest.json"),
    JSON.stringify({
      version: "0.0.0-test",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      includeIndex: false,
      encryption: { scheme: "omnesis.encrypted-artifact.v1", key: "install-root-key-v1" },
      encryptedManifest: "backup-manifest.full.json.enc",
      files: [
        { name: "omnesis.db.enc", bytes: 1, encrypted: true },
        { name: "keyring/storage-keys/main-db.json.enc", bytes: 1, encrypted: true },
      ],
    }),
  );

  return { backupDir, rootKey, recoveryCode };
}

describe("omnesis restore", () => {
  test("restores an encrypted backup when the root key is already in the target keyring", async () => {
    const { backupDir, rootKey } = await buildEncryptedBackup();
    const target = tmp("omnesis-restore-target-");
    await writeInstallRootKey(rootKey, { backend: "file", configDir: target });

    const summary = await restore(backupDir, {
      target,
      backend: "file",
      codeArg: undefined,
      envelopeFileArg: undefined,
      force: false,
    });

    expect(summary.rootKeyReseeded).toBe(false);
    expect(summary.encrypted).toBe(true);
    // Databases decrypt back to plaintext, openable snapshots.
    expect(readSqliteValues(join(target, "omnesis.db"))).toEqual(["alpha", "beta"]);
    // Wrapped storage key, marker, config, and the recovery envelope all landed.
    expect(existsSync(join(target, "keyring", "storage-keys", "main-db.json"))).toBe(true);
    expect(existsSync(join(target, "keyring", "storage-encryption-required"))).toBe(true);
    expect(readFileSync(join(target, "omnesis.json"), "utf8")).toContain("sources");
    expect(existsSync(join(target, "keyring", "recovery-envelope.json"))).toBe(true);
    // No encrypted artifacts and no backup metadata leak into the config dir.
    expect(existsSync(join(target, "backup-manifest.json"))).toBe(false);
    expect(existsSync(join(target, "backup-manifest.full.json"))).toBe(false);
    expect(allFilesUnder(target).some((f) => f.endsWith(".enc"))).toBe(false);
    // Config dir + secret files carry owner-only modes.
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(statSync(join(target, "token")).mode & 0o777).toBe(0o600);
  });

  test("a --force restore over an existing corpus replaces it atomically", async () => {
    const { backupDir, rootKey } = await buildEncryptedBackup();
    const target = tmp("omnesis-restore-target-");
    await writeInstallRootKey(rootKey, { backend: "file", configDir: target });
    writeFileSync(join(target, "omnesis.db"), "stale corpus from a previous epoch");

    const summary = await restore(backupDir, {
      target,
      backend: "file",
      codeArg: undefined,
      envelopeFileArg: undefined,
      force: true,
    });

    expect(summary.rootKeyReseeded).toBe(false);
    // The stale corpus is gone; the backup's corpus is in place.
    expect(readSqliteValues(join(target, "omnesis.db"))).toEqual(["alpha", "beta"]);
    expect(existsSync(`${target}.superseded-${process.pid}`)).toBe(false);
  });

  test("reconstitutes the root key from the recovery code on a keyring-less target", async () => {
    const { backupDir, rootKey, recoveryCode } = await buildEncryptedBackup();
    const target = tmp("omnesis-restore-target-");

    const summary = await restore(backupDir, {
      target,
      backend: "file",
      codeArg: recoveryCode,
      envelopeFileArg: undefined,
      force: false,
    });

    expect(summary.rootKeyReseeded).toBe(true);
    // The reconstituted key matches the original and now lives in the target.
    expect(await readInstallRootKey({ backend: "file", configDir: target })).toBe(rootKey);
    expect(readSqliteValues(join(target, "omnesis.db"))).toEqual(["alpha", "beta"]);
  });

  // The gap that let the precedence bug ship: every recovery test above uses a
  // keyring-less target, so nothing asserted what happens when the target has a
  // key of its own AND the operator supplies a code -- which is the documented
  // path, where the new machine ran the installer before restoring.
  test("prefers a supplied recovery code over a root key the target already holds", async () => {
    const { backupDir, rootKey, recoveryCode } = await buildEncryptedBackup();
    const target = tmp("omnesis-restore-target-");
    // What a machine that just ran the installer has: its own, different key.
    await ensureInstallRootKey({ backend: "file", configDir: target });
    expect(await readInstallRootKey({ backend: "file", configDir: target })).not.toBe(rootKey);

    const summary = await restore(backupDir, {
      target,
      backend: "file",
      codeArg: recoveryCode,
      envelopeFileArg: undefined,
      force: true,
    });

    expect(summary.rootKeyReseeded).toBe(true);
    expect(await readInstallRootKey({ backend: "file", configDir: target })).toBe(rootKey);
    expect(readSqliteValues(join(target, "omnesis.db"))).toEqual(["alpha", "beta"]);
  });

  test("a backup encrypted under another key says so instead of a stream error", async () => {
    const { backupDir } = await buildEncryptedBackup();
    const target = tmp("omnesis-restore-target-");
    await ensureInstallRootKey({ backend: "file", configDir: target });

    await expect(
      restore(backupDir, {
        target,
        backend: "file",
        codeArg: undefined,
        envelopeFileArg: undefined,
        force: true,
      }),
    ).rejects.toThrow(/not encrypted with this machine's root key/);
  });

  // A headless install writes keyring.pass into the config dir and wires it into
  // its unit with LoadCredential=. No backup carries it, and the restore swaps
  // the whole config dir, so without this the service can never start again.
  test("keeps the machine's keyring passphrase across a restore", async () => {
    const { backupDir, rootKey } = await buildEncryptedBackup();
    const target = tmp("omnesis-restore-target-");
    await writeInstallRootKey(rootKey, { backend: "file", configDir: target });
    writeFileSync(join(target, "keyring.pass"), "a-passphrase\n", { mode: 0o600 });

    await restore(backupDir, {
      target,
      backend: "file",
      codeArg: undefined,
      envelopeFileArg: undefined,
      force: true,
    });

    expect(existsSync(join(target, "keyring.pass"))).toBe(true);
    expect(readFileSync(join(target, "keyring.pass"), "utf8")).toBe("a-passphrase\n");
    expect(statSync(join(target, "keyring.pass")).mode & 0o777).toBe(0o600);
    expect(readSqliteValues(join(target, "omnesis.db"))).toEqual(["alpha", "beta"]);
  });

  test("a restore into a target without one invents no credential", async () => {
    const { backupDir, recoveryCode } = await buildEncryptedBackup();
    const target = tmp("omnesis-restore-target-");

    await restore(backupDir, {
      target,
      backend: "file",
      codeArg: recoveryCode,
      envelopeFileArg: undefined,
      force: false,
    });

    expect(existsSync(join(target, "keyring.pass"))).toBe(false);
  });

  test("rejects a wrong recovery code and cannot decrypt", async () => {
    const { backupDir } = await buildEncryptedBackup();
    const target = tmp("omnesis-restore-target-");

    await expect(
      restore(backupDir, {
        target,
        backend: "file",
        codeArg: "0000-0000-0000-0000-0000-0000-0000-0000",
        envelopeFileArg: undefined,
        force: false,
      }),
    ).rejects.toThrow();
    expect(existsSync(join(target, "omnesis.db"))).toBe(false);
  });

  test("refuses to overwrite an existing corpus without --force", async () => {
    const { backupDir, rootKey } = await buildEncryptedBackup();
    const target = tmp("omnesis-restore-target-");
    await writeInstallRootKey(rootKey, { backend: "file", configDir: target });
    writeFileSync(join(target, "omnesis.db"), "existing corpus");

    await expect(
      restore(backupDir, {
        target,
        backend: "file",
        codeArg: undefined,
        envelopeFileArg: undefined,
        force: false,
      }),
    ).rejects.toThrow(/already contains a corpus/);
  });

  test("rejects a directory that is not a backup", async () => {
    const notABackup = tmp("omnesis-restore-notbackup-");
    const target = tmp("omnesis-restore-target-");
    await expect(
      restore(notABackup, {
        target,
        backend: "file",
        codeArg: undefined,
        envelopeFileArg: undefined,
        force: false,
      }),
    ).rejects.toThrow(/backup/i);
  });

  test("restores an unencrypted backup without any root key", async () => {
    // A plaintext backup (no encryption field, no .enc files) restores by copy
    // and needs no keyring.
    const backupDir = tmp("omnesis-restore-plain-");
    makeSqliteDb(join(backupDir, "omnesis.db"), ["only"]);
    writeFileSync(join(backupDir, "omnesis.json"), JSON.stringify({ sources: [] }));
    writeFileSync(
      join(backupDir, "backup-manifest.json"),
      JSON.stringify({
        version: "0.0.0-test",
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(0).toISOString(),
        includeIndex: false,
        files: [{ name: "omnesis.db", bytes: 1 }],
      }),
    );
    const target = tmp("omnesis-restore-target-");

    const summary = await restore(backupDir, {
      target,
      backend: "file",
      codeArg: undefined,
      envelopeFileArg: undefined,
      force: false,
    });

    expect(summary.encrypted).toBe(false);
    expect(summary.rootKeyReseeded).toBe(false);
    expect(readSqliteValues(join(target, "omnesis.db"))).toEqual(["only"]);
    expect(readdirSync(target)).not.toContain("backup-manifest.json");
  });
});

describe("an offline backup of a stopped gateway", () => {
  test("restores its databases, uncheckpointed pages included, and its config material", async () => {
    // A gateway stopped hard leaves committed transactions in the write-ahead
    // log: copy a live store's files while a writer still holds them open.
    const live = tmp("omnesis-offline-live-");
    const configDir = tmp("omnesis-offline-src-");
    const db = new Database(join(live, "omnesis.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.exec("CREATE TABLE items (val TEXT)");
    const insert = db.prepare("INSERT INTO items (val) VALUES (?)");
    for (const value of ["alpha", "beta", "gamma"]) insert.run(value);
    for (const suffix of ["", "-wal", "-shm"]) {
      copyFileSync(join(live, `omnesis.db${suffix}`), join(configDir, `omnesis.db${suffix}`));
    }
    db.close();
    writeFileSync(join(configDir, "omnesis.json"), '{"gateway":{"port":17600}}\n');
    writeFileSync(join(configDir, "token"), "token-envelope");

    const outcome = await takeOfflineGatewayBackup({
      configDir,
      note: "pre-update 9.9.0 to v9.9.1",
      purpose: "pre-update",
      version: "9.9.0",
      env: {},
      log: { info: () => {}, warn: () => {} },
    });
    if (outcome.kind !== "copied") throw new Error(`expected a copy, got ${outcome.kind}`);
    expect(existsSync(join(outcome.path, "omnesis.db-wal"))).toBe(true);

    const target = join(tmp("omnesis-offline-dst-"), "config");
    const summary = await restore(outcome.path, {
      target,
      backend: "file",
      codeArg: undefined,
      envelopeFileArg: undefined,
      force: false,
    });
    expect(summary.encrypted).toBe(false);
    expect(readSqliteValues(join(target, "omnesis.db"))).toEqual(["alpha", "beta", "gamma"]);
    expect(readFileSync(join(target, "omnesis.json"), "utf8")).toContain("17600");
    expect(readFileSync(join(target, "token"), "utf8")).toBe("token-envelope");
    expect(existsSync(join(target, "backup-manifest.json"))).toBe(false);
  });
});

/**
 * Every file under `root` with its content, for comparing a tree before and
 * after. The gateway lock's own files are the lock's, which the restore takes.
 */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of allFilesUnder(root)) {
    if (rel.startsWith("gateway.lock")) continue;
    out[rel] = readFileSync(join(root, rel), "utf8");
  }
  return out;
}

/** A plaintext backup at `<configDir>/backups/<name>`, as `omnesis backup --list` names one. */
function plainBackupInside(
  configDir: string,
  name: string,
  files: Record<string, string | string[]>,
): string {
  const backupDir = join(configDir, "backups", name);
  mkdirSync(backupDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(backupDir, rel)), { recursive: true });
    if (Array.isArray(content)) makeSqliteDb(join(backupDir, rel), content);
    else writeFileSync(join(backupDir, rel), content);
  }
  writeFileSync(
    join(backupDir, "backup-manifest.json"),
    JSON.stringify({
      version: "0.0.0-test",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      includeIndex: Object.keys(files).includes("index.db"),
      files: Object.keys(files).map((n) => ({ name: n, bytes: 1 })),
    }),
  );
  return backupDir;
}

/** What a Docker install's config dir holds beside its corpus, none of it a backup's. */
function machineOwnedFiles(configDir: string): Record<string, string> {
  const files: Record<string, string> = {
    "backups/2026-01-02T03-04-05/backup-manifest.json": '{"note":"an older backup"}',
    "backups/2026-01-02T03-04-05/omnesis.db": "older corpus",
    "models/embedder.gguf": "gigabytes of weights",
    "exports/2026-01-03.jsonl": "an export",
    "logs/gateway.log": "log lines",
    "docker-compose.yml": "services: {}\n",
    "install-method": "docker\n",
    "shared-folders": "/srv/example-vault\n",
    "keyring.pass": "machine passphrase\n",
    "update-state.json": "{}",
    "collector/collector-token": "the collector container's token",
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(configDir, rel)), { recursive: true });
    writeFileSync(join(configDir, rel), content);
  }
  return files;
}

describe("what a restore replaces and what it keeps", () => {
  test("a --force restore from a backup inside the config dir keeps everything the machine owns", async () => {
    const target = tmp("omnesis-restore-machine-");
    writeFileSync(join(target, "omnesis.db"), "the corpus being replaced");
    writeFileSync(join(target, "omnesis.json"), '{"gateway":{"port":1}}');
    const machine = machineOwnedFiles(target);
    const backupDir = plainBackupInside(target, "2026-02-03T04-05-06", {
      "omnesis.db": ["restored"],
      "omnesis.json": '{"gateway":{"port":17600}}',
    });
    const backupBefore = snapshotTree(backupDir);

    await restore(backupDir, {
      target,
      backend: "file",
      codeArg: undefined,
      envelopeFileArg: undefined,
      force: true,
    });

    expect(readSqliteValues(join(target, "omnesis.db"))).toEqual(["restored"]);
    expect(readFileSync(join(target, "omnesis.json"), "utf8")).toContain("17600");
    for (const [rel, content] of Object.entries(machine)) {
      expect(readFileSync(join(target, rel), "utf8"), rel).toBe(content);
    }
    // The backup restored from is still there, unchanged, to restore again.
    expect(snapshotTree(backupDir)).toEqual(backupBefore);
    // Nothing of the restore's own working state is left behind.
    expect(readdirSync(target).filter((name) => name.startsWith(".omnesis-restore"))).toEqual([]);
    expect(readdirSync(dirname(target)).filter((n) => n.startsWith(".omnesis-restore"))).toEqual(
      [],
    );
  });

  test("removes the backup-owned entries the backup does not carry, and the derived index", async () => {
    const target = tmp("omnesis-restore-stale-");
    for (const name of [
      "omnesis.db",
      "omnesis.db-wal",
      "index.db",
      "index.db-wal",
      "index.db-shm",
      "index.usearch",
      "index.usearch.enc",
      "index-2.usearch",
      "watch.db",
      "analytics.db",
      "analytics.db.wal",
      "plaid-credentials.json",
      "collector-token",
    ]) {
      writeFileSync(join(target, name), `stale ${name}`);
    }
    mkdirSync(join(target, "provider-example", "account-one"), { recursive: true });
    writeFileSync(join(target, "provider-example", "account-one", "credentials.json"), "stale");
    writeFileSync(join(target, "provider-example", "account-one", "cursor.json"), "machine");
    mkdirSync(join(target, "sweeps"), { recursive: true });
    writeFileSync(join(target, "sweeps", "weekly.md"), "a sweep written after the backup");
    // Taken without the index, as the pre-update backup is.
    const backupDir = plainBackupInside(target, "2026-02-03T04-05-06", {
      "omnesis.db": ["restored"],
      "watch.db": "restored watch journal",
    });

    await restore(backupDir, {
      target,
      backend: "file",
      codeArg: undefined,
      envelopeFileArg: undefined,
      force: true,
    });

    expect(readSqliteValues(join(target, "omnesis.db"))).toEqual(["restored"]);
    expect(readFileSync(join(target, "watch.db"), "utf8")).toBe("restored watch journal");
    for (const gone of [
      "omnesis.db-wal",
      "index.db",
      "index.db-wal",
      "index.db-shm",
      "index.usearch",
      "index.usearch.enc",
      "index-2.usearch",
      "analytics.db",
      "analytics.db.wal",
      "plaid-credentials.json",
      "collector-token",
      "provider-example/account-one/credentials.json",
      "sweeps",
    ]) {
      expect(existsSync(join(target, gone)), gone).toBe(false);
    }
    // The provider's other state is not a backup's, so it stays.
    expect(
      readFileSync(join(target, "provider-example", "account-one", "cursor.json"), "utf8"),
    ).toBe("machine");
  });

  test("keeps the machine's own root key when the backup does not reseed it", async () => {
    const target = tmp("omnesis-restore-rootkey-");
    await ensureInstallRootKey({ backend: "file", configDir: target });
    const rootKey = await readInstallRootKey({ backend: "file", configDir: target });
    writeFileSync(join(target, "omnesis.db"), "corpus");
    // An offline backup copies stores byte for byte, still sealed under storage
    // keys this machine's root key unwraps: losing that key loses the corpus.
    const backupDir = plainBackupInside(target, "pre-update", {
      "omnesis.db": ["restored"],
      "keyring/storage-keys/main-db.json": "wrapped under this machine's root key",
    });

    await restore(backupDir, {
      target,
      backend: "file",
      codeArg: undefined,
      envelopeFileArg: undefined,
      force: true,
    });

    expect(await readInstallRootKey({ backend: "file", configDir: target })).toBe(rootKey);
    expect(readFileSync(join(target, "keyring", "storage-keys", "main-db.json"), "utf8")).toBe(
      "wrapped under this machine's root key",
    );
  });

  test("restores the backup's .env but keeps the lines that say how this machine runs", async () => {
    const target = tmp("omnesis-restore-env-");
    writeFileSync(join(target, "omnesis.db"), "corpus");
    writeFileSync(
      join(target, ".env"),
      [
        "OMNESIS_IMAGE_TAG=0.9.4",
        "OMNESIS_SECRET_STORE=passphrase",
        `OMNESIS_KEYRING_PASSPHRASE_FILE=${join(target, "keyring.pass")}`,
        "OMNESIS_LOG_LEVEL=debug",
        "",
      ].join("\n"),
    );
    const backupDir = plainBackupInside(target, "older", {
      "omnesis.db": ["restored"],
      ".env": [
        "# operator settings",
        "OMNESIS_IMAGE_TAG=0.9.1",
        "OMNESIS_EXPERIMENTAL=1",
        "OMNESIS_SECRET_STORE=macos-keychain",
        "",
      ].join("\n"),
    });

    await restore(backupDir, {
      target,
      backend: "file",
      codeArg: undefined,
      envelopeFileArg: undefined,
      force: true,
    });

    const env = readFileSync(join(target, ".env"), "utf8");
    expect(env).toContain("# operator settings");
    expect(env).toContain("OMNESIS_EXPERIMENTAL=1");
    expect(env).toContain("OMNESIS_IMAGE_TAG=0.9.4");
    expect(env).toContain("OMNESIS_SECRET_STORE=passphrase");
    expect(env).toContain(`OMNESIS_KEYRING_PASSPHRASE_FILE=${join(target, "keyring.pass")}`);
    expect(env).not.toContain("0.9.1");
    expect(env).not.toContain("macos-keychain");
    // A setting the backup does not carry is the backup's to drop.
    expect(env).not.toContain("OMNESIS_LOG_LEVEL");
    expect(statSync(join(target, ".env")).mode & 0o777).toBe(0o600);
  });

  // A Docker install bind-mounts the config dir into the container, where its
  // mount point cannot be renamed and the directory above it is not the
  // operator's to write: the restore has to work inside the directory alone.
  test("restores without renaming the config dir or writing beside it", async () => {
    const parent = tmp("omnesis-restore-mount-");
    const target = join(parent, "config");
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(target, "omnesis.db"), "corpus");
    const backupDir = plainBackupInside(target, "b", { "omnesis.db": ["restored"] });
    const inode = statSync(target).ino;
    chmodSync(parent, 0o500);
    try {
      await restore(backupDir, {
        target,
        backend: "file",
        codeArg: undefined,
        envelopeFileArg: undefined,
        force: true,
      });
    } finally {
      chmodSync(parent, 0o700);
    }
    expect(statSync(target).ino).toBe(inode);
    expect(readSqliteValues(join(target, "omnesis.db"))).toEqual(["restored"]);
  });

  test("a swap that fails part-way puts the target back exactly as it was", async () => {
    // Every rename the swap makes is a point it can fail at; try each one.
    for (let failAt = 1; ; failAt++) {
      const target = tmp("omnesis-restore-rollback-");
      writeFileSync(join(target, "omnesis.db"), "the corpus before");
      writeFileSync(join(target, "index.db"), "the index before");
      writeFileSync(join(target, "index.usearch"), "the graph before");
      writeFileSync(join(target, "omnesis.json"), '{"before":true}');
      mkdirSync(join(target, "tls"));
      writeFileSync(join(target, "tls", "cert.pem"), "the certificate before");
      machineOwnedFiles(target);
      const backupDir = plainBackupInside(target, "b", {
        "omnesis.db": ["restored"],
        "omnesis.json": '{"after":true}',
        "tls/cert.pem": "the certificate after",
        "sweeps/weekly.md": "a sweep",
      });
      const before = snapshotTree(target);

      let renames = 0;
      let failed = false;
      const rename = (from: string, to: string): void => {
        renames += 1;
        if (renames === failAt) {
          failed = true;
          throw Object.assign(new Error("simulated rename failure"), { code: "EIO" });
        }
        renameSync(from, to);
      };
      const outcome = await restore(backupDir, {
        target,
        backend: "file",
        codeArg: undefined,
        envelopeFileArg: undefined,
        force: true,
        rename,
      }).then(
        () => null,
        (err: unknown) => err,
      );
      if (!failed) {
        // The failure point is past the last rename: the restore went through.
        expect(outcome).toBeNull();
        expect(failAt).toBeGreaterThan(2);
        break;
      }
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/simulated rename failure/);
      expect(snapshotTree(target), `failing rename #${failAt}`).toEqual(before);
    }
  });

  test("refuses while a gateway holds the config dir", async () => {
    const target = tmp("omnesis-restore-locked-");
    writeFileSync(join(target, "omnesis.db"), "corpus");
    const backupDir = plainBackupInside(target, "b", { "omnesis.db": ["restored"] });
    const lock = await acquireGatewayLock(target, { waitMs: 0 });
    try {
      await expect(
        restore(backupDir, {
          target,
          backend: "file",
          codeArg: undefined,
          envelopeFileArg: undefined,
          force: true,
        }),
      ).rejects.toThrow(/still owns/);
    } finally {
      lock.release();
    }
    expect(readFileSync(join(target, "omnesis.db"), "utf8")).toBe("corpus");
  });
});
