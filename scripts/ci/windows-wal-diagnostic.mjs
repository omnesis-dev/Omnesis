// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

// Synthetic, single-owner diagnostic. The checkout selects dependencies only;
// every database is new and lives in this invocation's unique temporary directory.
// This is not a product latency verdict and never changes product test budgets.
const rows = 16384;
const bytes = 3500; // Leave encrypted-page reserve room: one row per page in every variant.
const key = Buffer.alloc(32, 0x35).toString("hex"); // Invented benchmark data, never a user key.
const handles = new Set();
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let root;
let stage = "dependencies";
let complete = false;
let failed = false;
let trials = 0;
let verified = 0;

function errorRecord(error) {
  const code =
    typeof error?.code === "string" &&
    /^(?:SQLITE_[A-Z_]{1,50}|ERR_ASSERTION|ERR_DLOPEN_FAILED|MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED)$/u.test(
      error.code,
    )
      ? error.code
      : "failed";
  // No error messages/stacks, paths, raw database values or keys enter the record.
  return { phase: "wal-library-control-error", stage, code };
}
function open(variant, path, readonly = false) {
  const db = new variant.Db(path, { readonly });
  handles.add(db);
  if (variant.encrypted) {
    db.pragma("cipher='sqlcipher'");
    db.pragma("legacy=4");
    db.pragma(`key='${key}'`);
  }
  return db;
}
function close(db) {
  db.close();
  handles.delete(db);
}
function configure(db) {
  db.pragma("journal_mode=WAL");
  db.pragma("foreign_keys=ON");
  db.pragma("busy_timeout=5000");
  db.pragma("mmap_size=0");
  db.pragma("wal_autocheckpoint=0");
  db.pragma("journal_size_limit=-1");
  db.pragma("checkpoint_fullfsync=ON");
  db.pragma("synchronous=FULL");
  db.pragma("cache_size=-16000");
}
function sqliteVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:\.\d+)?$/u.test(value)
    ? value
    : "unavailable";
}
function sourceId(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [0-9a-f]{40,64}(?:alt\d+)?$/iu.test(value)
    ? value
    : "unavailable";
}

try {
  assert.equal(process.versions.node.split(".")[0], "24");
  assert.ok(process.argv.length <= 3);
  const checkout = resolve(process.argv[2] ?? process.cwd());
  const require = createRequire(join(checkout, "package.json"));
  for (const name of ["better-sqlite3", "better-sqlite3-multiple-ciphers"])
    assert.equal(require(`${name}/package.json`).version, "13.0.3");
  const Plain = require("better-sqlite3");
  const Fork = require("better-sqlite3-multiple-ciphers");
  const variants = [
    { name: "plain-library", Db: Plain, encrypted: false },
    { name: "fork-plaintext", Db: Fork, encrypted: false },
    { name: "fork-encrypted", Db: Fork, encrypted: true },
  ];
  root = mkdtempSync(join(tmpdir(), "omnesis-wal-library-control-"));
  emit({
    phase: "wal-library-control-start",
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    packageVersion: "13.0.3",
    rows,
    payloadBytes: bytes,
    variants: variants.length,
  });
  for (const variant of variants) {
    stage = "seed";
    const path = join(root, variant.name + ".db");
    let db = open(variant, path);
    try {
      configure(db);
      db.exec(
        "CREATE TABLE control(id INTEGER PRIMARY KEY,stamp INTEGER NOT NULL,payload BLOB NOT NULL)",
      );
      const insert = db.prepare("INSERT INTO control VALUES (?,0,?)");
      const payload = Buffer.alloc(bytes, 0x4b);
      const seeded = performance.now();
      db.transaction(() => {
        for (let id = 1; id <= rows; id++) insert.run(id, payload);
      })();
      // Solitary setup only: no worker, reader mapping or concurrent handle exists.
      db.pragma("wal_checkpoint(TRUNCATE)");
      emit({
        phase: "wal-library-control-seed",
        variant: variant.name,
        seedMs: performance.now() - seeded,
        pageSize: db.pragma("page_size", { simple: true }),
        pageCount: db.pragma("page_count", { simple: true }),
        sqlite: sqliteVersion(db.prepare("SELECT sqlite_version() AS version").get().version),
        sourceId: sourceId(db.prepare("SELECT sqlite_source_id() AS id").get().id),
        compileOptions: db
          .pragma("compile_options")
          .map((row) => row.compile_options)
          .filter(
            (value) =>
              typeof value === "string" &&
              /^[A-Z][A-Z0-9_]*(?:=[A-Za-z0-9_+.,-]{1,120})?$/u.test(value),
          ),
        synchronous: db.pragma("synchronous", { simple: true }),
        checkpointFullFsync: db.pragma("checkpoint_fullfsync", {
          simple: true,
        }),
        cacheKib: -db.pragma("cache_size", { simple: true }),
      });
      const update = db.prepare("UPDATE control SET stamp=?,payload=? WHERE id=?");
      let stamp = 0;
      for (const count of [128, 2048])
        for (const locality of ["contiguous", "scattered"]) {
          stage = "trial";
          stamp++;
          const next = Buffer.alloc(bytes, 0x50 + stamp);
          const cpuBeforeWrite = process.cpuUsage();
          const writeStart = performance.now();
          db.transaction(() => {
            for (let index = 0; index < count; index++) {
              const id = locality === "contiguous" ? index + 1 : ((index * 7919 + 101) % rows) + 1;
              update.run(stamp, next, id);
            }
          })();
          const writeMs = performance.now() - writeStart;
          const writeCpu = process.cpuUsage(cpuBeforeWrite);
          const probeStart = performance.now();
          const before = db.pragma("wal_checkpoint(NOOP)")[0];
          const probeMs = performance.now() - probeStart;
          const cpuStart = process.cpuUsage();
          const ioStart = process.resourceUsage();
          const started = performance.now();
          const checkpoint = db.pragma("wal_checkpoint(PASSIVE)")[0];
          const checkpointMs = performance.now() - started;
          const cpu = process.cpuUsage(cpuStart);
          const io = process.resourceUsage();
          assert.equal(checkpoint.busy, 0);
          assert.equal(checkpoint.checkpointed, checkpoint.log);
          assert.equal(
            db.prepare("SELECT count(*) AS count FROM control WHERE stamp=?").get(stamp).count,
            count,
          );
          assert.deepEqual(
            db.prepare("SELECT payload FROM control WHERE stamp=? LIMIT 1").get(stamp).payload,
            next,
          );
          trials++;
          emit({
            phase: "wal-library-control-checkpoint",
            variant: variant.name,
            locality,
            updatedRows: count,
            writeMs,
            writeCpuMs: (writeCpu.user + writeCpu.system) / 1000,
            probeMs,
            pendingFrames: before.log - before.checkpointed,
            logFrames: checkpoint.log,
            copiedFrames: checkpoint.checkpointed,
            checkpointMs,
            cpuMs: (cpu.user + cpu.system) / 1000,
            cpuUserMs: cpu.user / 1000,
            cpuSystemMs: cpu.system / 1000,
            fsReadOps: io.fsRead - ioStart.fsRead,
            fsWriteOps: io.fsWrite - ioStart.fsWrite,
          });
        }
      close(db);
      db = null;
      stage = "verify";
      const verify = open(variant, path, true);
      try {
        assert.equal(verify.prepare("SELECT count(*) AS count FROM control").get().count, rows);
        assert.equal(
          verify.prepare("SELECT count(*) AS count FROM control WHERE stamp=4").get().count,
          2048,
        );
        assert.equal(verify.pragma("quick_check", { simple: true }), "ok");
      } finally {
        close(verify);
      }
      verified++;
      emit({
        phase: "wal-library-control-verify",
        variant: variant.name,
        reopenedDataValid: true,
      });
    } finally {
      if (db) close(db);
    }
  }
  assert.equal(trials, 12);
  assert.equal(verified, 3);
  complete = true;
} catch (error) {
  failed = true;
  emit(errorRecord(error));
} finally {
  stage = "cleanup";
  for (const db of [...handles]) {
    try {
      close(db);
    } catch (error) {
      failed = true;
      emit(errorRecord(error));
    }
  }
  if (root && handles.size === 0) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      failed = true;
      emit(errorRecord(error));
    }
  } else if (root)
    emit({
      phase: "wal-library-control-retained",
      openDatabaseHandles: handles.size,
    });
}
if (complete && !failed)
  emit({
    phase: "wal-library-control-summary",
    complete: true,
    variants: verified,
    trials,
    performanceVerdict: "diagnostic-only",
  });
else process.exitCode = 1;
