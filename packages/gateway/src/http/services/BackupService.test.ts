// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * BackupService coverage: the worker-thread VACUUM INTO path against
 * small temp SQLite stores, config-file allowlist copies, manifest
 * correctness, single-flight 409, includeIndex:false, the disk preflight,
 * the failure cleanup path, and list().
 */

import {
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
import Database from "better-sqlite3";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  decryptArtifactFileToBuffer,
  ensureInstallRootKey,
  isEncryptedArtifactFile,
  markSecretFileEncryptionRequiredSync,
} from "@omnesis/core";
import { GATEWAY_VERSION } from "../../version.js";
import { ConflictError, HttpError } from "../errors.js";
import { BackupService, backupManifestSchema, type BackupServiceOptions } from "./BackupService.js";

const PRE_UPDATE = { purpose: "pre-update" as const };

function makeSqliteDb(path: string, values: string[]): void {
  const db = new Database(path);
  db.exec("CREATE TABLE items (val TEXT)");
  const insert = db.prepare("INSERT INTO items (val) VALUES (?)");
  for (const v of values) insert.run(v);
  db.close();
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

// statfs stub with effectively unlimited free space.
const plentyOfDisk = () => ({ bavail: 1_000_000_000, bsize: 4096 });

let configDir: string;
let gatewayDbPath: string;
let indexDbPath: string;
let watchDbPath: string;
let analyticsDbPath: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "omnesis-backup-svc-"));
  gatewayDbPath = join(configDir, "omnesis.db");
  indexDbPath = join(configDir, "index.db");
  analyticsDbPath = join(configDir, "analytics.db");
  makeSqliteDb(gatewayDbPath, ["alpha", "beta"]);
  makeSqliteDb(indexDbPath, ["chunk-1"]);
  watchDbPath = join(configDir, "watch.db");
  makeSqliteDb(watchDbPath, ["watch-1"]);
  // Stand-in for the DuckDB store; only its size feeds the preflight —
  // the copy itself goes through the injected analyticsBackup port.
  writeFileSync(analyticsDbPath, "duckdb-placeholder");

  // Config material on the copy allowlist.
  writeFileSync(join(configDir, "omnesis.json"), JSON.stringify({ sources: [] }));
  // The operator's standing instructions to the agent. Unlike the privacy
  // policy — a mirror of a row the database restore brings back — this file
  // exists nowhere else, so a backup that skipped it would lose it for good.
  writeFileSync(join(configDir, "OMNESIS.md"), "# House rules\n\nAnswer in metric units.\n");
  writeFileSync(join(configDir, "token"), "fake-admin-token");
  writeFileSync(join(configDir, "collector-token"), "fake-collector-token");
  mkdirSync(join(configDir, "keyring", "storage-keys"), { recursive: true });
  writeFileSync(join(configDir, "keyring", "storage-encryption-required"), "required");
  writeFileSync(join(configDir, "keyring", "storage-keys", "main-db.json"), "fake-wrapped-key");
  // Root-key recovery envelope (sealed under the operator's recovery code).
  // Shape mirrors RecoveryEnvelopeV1 from @omnesis/core; the base64 fields are
  // invented placeholders — the BackupService treats the file as opaque bytes.
  writeFileSync(
    join(configDir, "keyring", "recovery-envelope.json"),
    JSON.stringify({
      omnesis: "omnesis.recovery-key",
      version: 1,
      alg: "aes-256-gcm",
      kdf: "scrypt",
      n: 32768,
      r: 8,
      p: 1,
      salt: "c2FsdC1wbGFjZWhvbGRlcg",
      iv: "aXYtcGxhY2Vob2xkZXI",
      tag: "dGFnLXBsYWNlaG9sZGVy",
      ciphertext: "Y2lwaGVydGV4dC1wbGFjZWhvbGRlcg",
    }),
  );
  writeFileSync(join(configDir, "google-credentials.json"), JSON.stringify({ clientId: "fake" }));
  mkdirSync(join(configDir, "config-secrets"));
  writeFileSync(join(configDir, "config-secrets", "aW5mZXJlbmNl.secret"), "fake-api-key");
  mkdirSync(join(configDir, "tls"));
  writeFileSync(join(configDir, "tls", "cert.pem"), "fake-cert");
  writeFileSync(join(configDir, "tls", "key.pem"), "fake-key");

  // Material that must NOT land in a backup.
  mkdirSync(join(configDir, "models"));
  writeFileSync(join(configDir, "models", "embed.gguf"), "weights");
  writeFileSync(join(configDir, "index.usearch"), "vectors");
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function makeService(overrides?: Partial<BackupServiceOptions>): BackupService {
  return new BackupService({
    configDir,
    gatewayDbPath,
    indexDbPath,
    watchDbPath,
    analyticsDbPath,
    analyticsBackup: async (dest) => {
      writeFileSync(dest, "analytics-copy");
    },
    statfs: plentyOfDisk,
    ...overrides,
  });
}

function singleBackupDir(): string {
  const backupsDir = join(configDir, "backups");
  const dirs = readdirSync(backupsDir);
  expect(dirs.length).toBe(1);
  return join(backupsDir, dirs[0]);
}

/** Run one backup to completion and hand back its manifest. */
async function runBackup(service: BackupService) {
  service.start({});
  await service.whenIdle();
  const dir = service.getStatus().lastResult!.path!;
  return backupManifestSchema.parse(
    JSON.parse(readFileSync(join(dir, "backup-manifest.json"), "utf8")),
  );
}

function writeBackupManifest(
  name: string,
  overrides: Partial<ReturnType<typeof backupManifestSchema.parse>> = {},
): string {
  const dir = join(configDir, "backups", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "backup-manifest.json"),
    `${JSON.stringify({
      version: GATEWAY_VERSION,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      files: [],
      includeIndex: false,
      ...overrides,
    })}\n`,
  );
  return dir;
}

describe("BackupService", () => {
  test("vacuumed copies open and contain the data; manifest is correct", async () => {
    const service = makeService();
    const { backupId } = service.start({ note: "pre-upgrade" });
    expect(backupId).toBeTruthy();
    expect(service.getStatus().running).toBe(true);
    await service.whenIdle();

    const status = service.getStatus();
    expect(status.running).toBe(false);
    expect(status.lastResult?.ok).toBe(true);
    expect(status.lastResult?.backupId).toBe(backupId);
    expect(status.lastResult?.totalBytes).toBeGreaterThan(0);

    const dir = singleBackupDir();
    // SQLite snapshots are real, openable databases with the source rows.
    expect(readSqliteValues(join(dir, "omnesis.db"))).toEqual(["alpha", "beta"]);
    expect(readSqliteValues(join(dir, "index.db"))).toEqual(["chunk-1"]);
    // The DuckDB copy went through the injected port.
    expect(readFileSync(join(dir, "analytics.db"), "utf8")).toBe("analytics-copy");
    // Config allowlist copied verbatim, including the tls/ dir.
    expect(readFileSync(join(dir, "omnesis.json"), "utf8")).toContain("sources");
    expect(readFileSync(join(dir, "token"), "utf8")).toBe("fake-admin-token");
    expect(readFileSync(join(dir, "collector-token"), "utf8")).toBe("fake-collector-token");
    expect(readFileSync(join(dir, "keyring", "storage-encryption-required"), "utf8")).toBe(
      "required",
    );
    expect(readFileSync(join(dir, "keyring", "storage-keys", "main-db.json"), "utf8")).toBe(
      "fake-wrapped-key",
    );
    // The root-key recovery envelope is bundled byte-identical to the source.
    expect(
      readFileSync(join(dir, "keyring", "recovery-envelope.json")).equals(
        readFileSync(join(configDir, "keyring", "recovery-envelope.json")),
      ),
    ).toBe(true);
    expect(readFileSync(join(dir, "google-credentials.json"), "utf8")).toContain("clientId");
    expect(readFileSync(join(dir, "config-secrets", "aW5mZXJlbmNl.secret"), "utf8")).toBe(
      "fake-api-key",
    );
    expect(readFileSync(join(dir, "tls", "cert.pem"), "utf8")).toBe("fake-cert");
    // Excluded material stays out.
    expect(existsSync(join(dir, "models"))).toBe(false);
    expect(existsSync(join(dir, "index.usearch"))).toBe(false);
    expect(existsSync(join(dir, "backups"))).toBe(false);

    const manifest = backupManifestSchema.parse(
      JSON.parse(readFileSync(join(dir, "backup-manifest.json"), "utf8")),
    );
    expect(manifest.version).toBe(GATEWAY_VERSION);
    expect(manifest.includeIndex).toBe(true);
    expect(manifest.purpose).toBe("operator");
    expect(manifest.note).toBe("pre-upgrade");
    expect(Date.parse(manifest.startedAt)).not.toBeNaN();
    expect(Date.parse(manifest.finishedAt)).not.toBeNaN();
    const names = manifest.files.map((f) => f.name);
    for (const expected of [
      "omnesis.db",
      "index.db",
      "watch.db",
      "analytics.db",
      "omnesis.json",
      "OMNESIS.md",
      "token",
      "collector-token",
      "keyring/storage-encryption-required",
      "keyring/storage-keys",
      "keyring/recovery-envelope.json",
      "google-credentials.json",
      "config-secrets",
      "tls",
    ]) {
      expect(names).toContain(expected);
    }
    for (const f of manifest.files) expect(f.bytes).toBeGreaterThan(0);
  });

  test("includeIndex: false skips index.db", async () => {
    const service = makeService();
    service.start({ includeIndex: false });
    await service.whenIdle();
    expect(service.getStatus().lastResult?.ok).toBe(true);

    const dir = singleBackupDir();
    expect(existsSync(join(dir, "omnesis.db"))).toBe(true);
    expect(existsSync(join(dir, "index.db"))).toBe(false);
    const manifest = backupManifestSchema.parse(
      JSON.parse(readFileSync(join(dir, "backup-manifest.json"), "utf8")),
    );
    expect(manifest.includeIndex).toBe(false);
    expect(manifest.files.map((f) => f.name)).not.toContain("index.db");
  });

  test("omits the recovery envelope when none has been exported", async () => {
    // An operator who never ran `keyring export-recovery` has no envelope; the
    // existsSync allowlist guard skips it and the exemption never fires.
    rmSync(join(configDir, "keyring", "recovery-envelope.json"), { force: true });
    const service = makeService();
    service.start();
    await service.whenIdle();
    expect(service.getStatus().lastResult?.ok).toBe(true);

    const dir = singleBackupDir();
    expect(existsSync(join(dir, "keyring", "recovery-envelope.json"))).toBe(false);
    const manifest = backupManifestSchema.parse(
      JSON.parse(readFileSync(join(dir, "backup-manifest.json"), "utf8")),
    );
    expect(manifest.files.map((f) => f.name)).not.toContain("keyring/recovery-envelope.json");
  });

  test("encrypts backup artifacts when an install root key exists", async () => {
    await ensureInstallRootKey({ backend: "file", configDir });
    const service = makeService({ secretStoreBackend: "file" });
    service.start({ note: "encrypted", ...PRE_UPDATE });
    await service.whenIdle();
    expect(service.getStatus().lastResult?.ok).toBe(true);

    const dir = singleBackupDir();
    expect(existsSync(join(dir, "omnesis.db"))).toBe(false);
    expect(isEncryptedArtifactFile(join(dir, "omnesis.db.enc"))).toBe(true);
    expect(existsSync(join(dir, "keyring", "storage-keys", "main-db.json"))).toBe(false);
    expect(isEncryptedArtifactFile(join(dir, "keyring", "storage-keys", "main-db.json.enc"))).toBe(
      true,
    );

    // The recovery envelope is the one artifact left unencrypted: it must stay
    // root-key-independent so a restore on a fresh machine (no root key yet)
    // can reconstitute the key from it. It survives byte-identical, is not an
    // encrypted-artifact file, and no `.enc` sibling is produced.
    expect(existsSync(join(dir, "keyring", "recovery-envelope.json.enc"))).toBe(false);
    expect(isEncryptedArtifactFile(join(dir, "keyring", "recovery-envelope.json"))).toBe(false);
    expect(
      readFileSync(join(dir, "keyring", "recovery-envelope.json")).equals(
        readFileSync(join(configDir, "keyring", "recovery-envelope.json")),
      ),
    ).toBe(true);

    const restoredPath = join(configDir, "restored-omnesis.db");
    writeFileSync(
      restoredPath,
      await decryptArtifactFileToBuffer(join(dir, "omnesis.db.enc"), {
        backend: "file",
        configDir,
      }),
    );
    expect(readSqliteValues(restoredPath)).toEqual(["alpha", "beta"]);

    const manifest = backupManifestSchema.parse(
      JSON.parse(readFileSync(join(dir, "backup-manifest.json"), "utf8")),
    );
    expect(manifest.encryption).toEqual({
      scheme: "omnesis.encrypted-artifact.v1",
      key: "install-root-key-v1",
    });
    expect(manifest.note).toBeUndefined();
    expect(manifest.purpose).toBe("pre-update");
    expect(manifest.encryptedManifest).toBe("backup-manifest.full.json.enc");
    expect(manifest.files).toContainEqual(
      expect.objectContaining({ name: "omnesis.db.enc", encrypted: true }),
    );
    expect(manifest.files).toContainEqual(
      expect.objectContaining({ name: "index.db.enc", encrypted: true }),
    );
    expect(manifest.files).toContainEqual(
      expect.objectContaining({ name: "analytics.db.enc", encrypted: true }),
    );
    expect(manifest.files).toContainEqual(
      expect.objectContaining({ name: "backup-manifest.full.json.enc", encrypted: true }),
    );
    // The recovery envelope keeps its plain name and is not flagged encrypted.
    expect(manifest.files.map((f) => f.name)).toContain("keyring/recovery-envelope.json");
    expect(manifest.files.map((f) => f.name)).not.toContain("keyring/recovery-envelope.json.enc");
    expect(
      manifest.files.find((f) => f.name === "keyring/recovery-envelope.json")?.encrypted,
    ).toBeFalsy();

    const fullManifest = backupManifestSchema.parse(
      JSON.parse(
        (
          await decryptArtifactFileToBuffer(join(dir, "backup-manifest.full.json.enc"), {
            backend: "file",
            configDir,
          })
        ).toString("utf8"),
      ),
    );
    expect(fullManifest.note).toBe("encrypted");
    expect(fullManifest.purpose).toBe("pre-update");
  });

  test("returns a conservative size estimate and excludes index.db when requested", async () => {
    const gatewayBytes = statSync(gatewayDbPath).size;
    const indexBytes = statSync(indexDbPath).size;
    const watchBytes = statSync(watchDbPath).size;
    const analyticsBytes = statSync(analyticsDbPath).size;
    const service = makeService();

    const withIndex = service.start();
    expect(withIndex.estimatedTotalBytes).toBe(
      Math.ceil((gatewayBytes + indexBytes + watchBytes + analyticsBytes) * 1.1),
    );
    await service.whenIdle();

    const withoutIndex = service.start({ includeIndex: false });
    expect(withoutIndex.estimatedTotalBytes).toBe(
      Math.ceil((gatewayBytes + watchBytes + analyticsBytes) * 1.1),
    );
    expect(withoutIndex.estimatedTotalBytes).toBeLessThan(withIndex.estimatedTotalBytes);
    await service.whenIdle();
  });

  test("fails closed when keyring-backed files are required but the root key is unavailable", async () => {
    markSecretFileEncryptionRequiredSync(configDir);
    const service = makeService({ secretStoreBackend: "file" });
    service.start({ note: "should-not-downgrade" });
    await service.whenIdle();

    const result = service.getStatus().lastResult;
    expect(result?.ok).toBe(false);
    expect(result?.error).toMatch(/install root key/);
    expect(readdirSync(join(configDir, "backups"))).toEqual([]);
  });

  test("second concurrent start() is rejected with a 409", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const service = makeService({
      analyticsBackup: async (dest) => {
        writeFileSync(dest, "analytics-copy");
        await gate;
      },
    });
    const { backupId } = service.start();

    let thrown: unknown;
    try {
      service.start();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConflictError);
    expect((thrown as ConflictError).status).toBe(409);

    release();
    await service.whenIdle();
    expect(service.getStatus().lastResult?.backupId).toBe(backupId);

    // Once idle, a new backup is accepted again.
    const second = service.start();
    expect(second.backupId).not.toBe(backupId);
    await service.whenIdle();
  });

  test("status reports the bytes written so far to the file in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let destExists!: () => void;
    const destWritten = new Promise<void>((resolve) => (destExists = resolve));
    let beforeDest: ReturnType<BackupService["getStatus"]>["current"];
    const service: BackupService = makeService({
      analyticsBackup: async (dest) => {
        // The production copy is staged elsewhere and moved in at the end, so
        // its destination does not exist while it runs.
        beforeDest = service.getStatus().current;
        writeFileSync(dest, "x".repeat(3000));
        destExists();
        await gate;
      },
    });
    service.start();
    await destWritten;

    expect(beforeDest?.currentFile).toBe("analytics.db");
    expect(beforeDest?.currentFileBytes).toBeUndefined();
    const inFlight = service.getStatus().current;
    expect(inFlight?.currentFile).toBe("analytics.db");
    expect(inFlight?.currentFileBytes).toBe(3000);
    expect(inFlight?.files.map((f) => f.name)).not.toContain("analytics.db");

    release();
    await service.whenIdle();
    expect(service.getStatus().current).toBeUndefined();
  });

  test("status tracks a VACUUM INTO snapshot while it is being written", async () => {
    // Large enough that the worker's vacuum spans many polls of the main thread.
    const big = new Database(gatewayDbPath);
    big.exec("CREATE TABLE filler (b BLOB)");
    const insert = big.prepare("INSERT INTO filler (b) VALUES (randomblob(8000))");
    big.transaction(() => {
      for (let i = 0; i < 10_000; i++) insert.run();
    })();
    big.close();

    const service = makeService();
    service.start({ includeIndex: false });
    const observed: number[] = [];
    for (;;) {
      const current = service.getStatus().current;
      if (!current || current.files.some((f) => f.name === "omnesis.db")) break;
      if (current.currentFile === "omnesis.db" && current.currentFileBytes !== undefined) {
        observed.push(current.currentFileBytes);
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await service.whenIdle();

    const finalBytes = service.getStatus().lastResult!.files.find((f) => f.name === "omnesis.db")!;
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.some((bytes) => bytes > 0)).toBe(true);
    expect(Math.max(...observed)).toBeLessThanOrEqual(finalBytes.bytes);
  });

  test("disk preflight fails fast with 507 when free space is insufficient", () => {
    // ~1 KB free vs several KB of source DBs.
    const service = makeService({ statfs: () => ({ bavail: 1, bsize: 1024 }) });
    let thrown: unknown;
    try {
      service.start();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(507);
    expect((thrown as HttpError).code).toBe("INSUFFICIENT_STORAGE");
    expect((thrown as HttpError).message).toMatch(/free disk space/i);
    expect(service.getStatus().running).toBe(false);
    // Preflight runs before the backup dir is created.
    expect(readdirSync(join(configDir, "backups"))).toEqual([]);
  });

  test("a backup that would eat the gateway's low-disk floor is refused", () => {
    // Room for the copy, but nothing left over: finishing would leave the
    // volume under the floor the ingest path already 507s below, so the
    // operator's backup would have bought them an outage.
    const service = makeService({
      statfs: () => ({ bavail: 64, bsize: 1024 }),
      minFreeDiskBytes: () => 512 * 1024 * 1024,
    });
    let thrown: unknown;
    try {
      service.start();
    } catch (err) {
      thrown = err;
    }
    expect((thrown as HttpError).status).toBe(507);
    expect((thrown as HttpError).message).toMatch(/keep .* free for the gateway to keep writing/i);
    expect(readdirSync(join(configDir, "backups"))).toEqual([]);
  });

  test("the floor only has to survive the copy, not sit unused on top of it", async () => {
    // Identical free space to the refusal above; only the floor differs, so the
    // floor is the sole variable under test. The guard must not refuse a backup
    // the volume can genuinely afford.
    const service = makeService({
      statfs: () => ({ bavail: 64, bsize: 1024 }),
      minFreeDiskBytes: () => 1024,
    });
    expect(() => service.start()).not.toThrow();
    await service.whenIdle();
  });

  test("an unset floor enforces no floor", async () => {
    // The same volume that the 512 MB floor above rejects is accepted when no
    // floor is configured — the option is the only thing standing in the way.
    const service = makeService({ statfs: () => ({ bavail: 64, bsize: 1024 }) });
    expect(() => service.start()).not.toThrow();
    await service.whenIdle();
  });

  test("a failed backup records the error and removes the partial dir", async () => {
    const service = makeService({
      analyticsBackup: async () => {
        throw new Error("duckdb copy exploded");
      },
    });
    const { backupId } = service.start();
    await service.whenIdle();

    const status = service.getStatus();
    expect(status.running).toBe(false);
    expect(status.lastResult?.ok).toBe(false);
    expect(status.lastResult?.backupId).toBe(backupId);
    expect(status.lastResult?.error).toContain("duckdb copy exploded");
    expect(readdirSync(join(configDir, "backups"))).toEqual([]);
    expect(service.list()).toEqual([]);
  });

  test("keeps the last two pre-update backups and preserves every unowned directory", async () => {
    let clockMs = Date.parse("2026-07-01T00:00:00.000Z");
    const service = makeService({
      // start() and completion each read the clock. Advancing by one second
      // makes every backup path an immutable identity for the assertions below.
      now: () => new Date((clockMs += 1_000)),
    });

    service.start({ note: "operator" });
    await service.whenIdle();
    const operatorPath = service.getStatus().lastResult!.path;

    const legacyPath = writeBackupManifest("legacy");
    const corruptPath = join(configDir, "backups", "corrupt");
    mkdirSync(corruptPath);
    writeFileSync(join(corruptPath, "backup-manifest.json"), "not-json");
    const strayPath = join(configDir, "backups", "stray");
    mkdirSync(strayPath);

    const created: string[] = [];
    for (let n = 0; n < 4; n++) {
      service.start({ ...PRE_UPDATE, note: `automatic-${n}` });
      await service.whenIdle();
      created.push(service.getStatus().lastResult!.path);
    }

    const listed = service.list();
    expect(listed.filter((backup) => backup.purpose === "pre-update")).toHaveLength(2);
    expect(existsSync(created.at(-1)!)).toBe(true);
    expect(existsSync(created.at(-2)!)).toBe(true);
    expect(existsSync(created[0]!)).toBe(false);
    expect(existsSync(created[1]!)).toBe(false);
    expect(existsSync(operatorPath)).toBe(true);
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(corruptPath)).toBe(true);
    expect(existsSync(strayPath)).toBe(true);
  });

  test("a malformed start time cannot displace a genuine recent pre-update backup", async () => {
    mkdirSync(join(configDir, "backups"), { recursive: true });
    const malformedPath = writeBackupManifest("malformed-time", {
      purpose: "pre-update",
      startedAt: "not-a-timestamp",
    });
    const service = makeService({ preUpdateRetentionCount: () => 2 });

    service.start(PRE_UPDATE);
    await service.whenIdle();
    const previousPath = service.getStatus().lastResult!.path;
    service.start(PRE_UPDATE);
    await service.whenIdle();
    const currentPath = service.getStatus().lastResult!.path;

    expect(existsSync(malformedPath)).toBe(true);
    expect(existsSync(previousPath)).toBe(true);
    expect(existsSync(currentPath)).toBe(true);
  });

  test("zero disables pre-update retention", async () => {
    const service = makeService({ preUpdateRetentionCount: () => 0 });
    for (let n = 0; n < 4; n++) {
      service.start(PRE_UPDATE);
      await service.whenIdle();
    }
    expect(service.list().filter((backup) => backup.purpose === "pre-update")).toHaveLength(4);
  });

  test("a failed pre-update backup prunes nothing", async () => {
    let fail = false;
    let retentionCount = 0;
    const service = makeService({
      preUpdateRetentionCount: () => retentionCount,
      analyticsBackup: async (dest) => {
        if (fail) throw new Error("duckdb copy exploded");
        writeFileSync(dest, "analytics-copy");
      },
    });
    for (let n = 0; n < 4; n++) {
      service.start(PRE_UPDATE);
      await service.whenIdle();
    }
    const before = service.list().map((backup) => backup.path);

    retentionCount = 2;
    fail = true;
    service.start(PRE_UPDATE);
    await service.whenIdle();

    expect(service.getStatus().lastResult?.ok).toBe(false);
    expect(service.list().map((backup) => backup.path)).toEqual(before);
  });

  test("always retains the completed backup when the clock moves backwards", async () => {
    mkdirSync(join(configDir, "backups"), { recursive: true });
    const futurePath = writeBackupManifest("future", {
      purpose: "pre-update",
      startedAt: "2030-01-01T00:00:00.000Z",
      finishedAt: "2030-01-01T00:00:01.000Z",
    });
    const service = makeService({
      preUpdateRetentionCount: () => 1,
      now: () => new Date("2020-01-01T00:00:00.000Z"),
    });

    service.start(PRE_UPDATE);
    await service.whenIdle();
    const currentPath = service.getStatus().lastResult!.path;

    expect(service.getStatus().lastResult?.ok).toBe(true);
    expect(existsSync(currentPath)).toBe(true);
    expect(existsSync(futurePath)).toBe(false);
    expect(service.list().map((backup) => backup.path)).toEqual([currentPath]);
  });

  test("list() returns manifests newest-first and collisions get a dir suffix", async () => {
    // A fixed clock forces both backups onto the same dir name, exercising
    // the collision suffix; startedAt sorting then keeps insertion order
    // stable via localeCompare on identical strings.
    const t1 = new Date("2026-06-01T10:00:00.000Z");
    const t2 = new Date("2026-06-02T10:00:00.000Z");
    let calls = 0;
    const service = makeService({
      // start() and run() each read the clock; first backup sees t1, the
      // second t2.
      now: () => (calls++ < 2 ? t1 : t2),
    });
    service.start();
    await service.whenIdle();
    service.start({ note: "second" });
    await service.whenIdle();

    const backups = service.list();
    expect(backups.length).toBe(2);
    expect(backups[0].startedAt).toBe(t2.toISOString());
    expect(backups[0].note).toBe("second");
    expect(backups[1].startedAt).toBe(t1.toISOString());
    expect(backups[0].path).not.toBe(backups[1].path);

    // Stray dirs without a manifest are ignored.
    mkdirSync(join(configDir, "backups", "not-a-backup"));
    expect(service.list().length).toBe(2);
  });

  test("dir-name collision under a frozen clock appends a numeric suffix", async () => {
    const frozen = new Date("2026-06-03T08:30:00.000Z");
    const service = makeService({ now: () => frozen });
    service.start();
    await service.whenIdle();
    service.start();
    await service.whenIdle();

    const dirs = readdirSync(join(configDir, "backups")).sort();
    expect(dirs).toEqual(["2026-06-03T08-30-00", "2026-06-03T08-30-00-2"]);
  });
});

describe("the watch journal", () => {
  test("is captured, because nothing else holds a watch's definition", async () => {
    // The event stream can be replayed from the corpus; what the operator
    // asked to be told about cannot be rebuilt from anything. A backup that
    // skipped this file would restore an install with no watches and no way to
    // notice until one failed to fire.
    const manifest = await runBackup(makeService());
    expect(manifest.files.map((f) => f.name)).toContain("watch.db");
  });

  test("is skipped without complaint on an install that has never run one", async () => {
    rmSync(watchDbPath, { force: true });
    const manifest = await runBackup(makeService());
    expect(manifest.files.map((f) => f.name)).not.toContain("watch.db");
  });
});
