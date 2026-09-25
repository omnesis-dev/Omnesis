// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * End-to-end of the encrypted-sidecar persistence flow at the handle level,
 * with a REAL usearch graph and REAL crypto: build → encrypted save → simulate
 * a restart (purge plaintext) → restore-if-consistent → load, and the failure
 * modes (write-seq desync, tamper) that MUST fall back to a rebuild rather than
 * serve a stale/wrong graph.
 */

import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { UsearchWriteHandle, UsearchReadHandle } from "./usearch-index.js";
import {
  EMBEDDING_DIM,
  createIndexDatabase,
  upsertChunks,
  getVectorWriteSeq,
  getUsearchSavedSeq,
  setUsearchSavedSeq,
} from "./db.js";
import {
  encryptSidecar,
  restoreActiveSidecar,
  readSidecarFingerprint,
} from "./usearch-sidecar-crypto.js";
import type Database from "better-sqlite3";

const KEY = randomBytes(32);
const MODEL = "Qwen/Qwen3-Embedding-0.6B";

function embedding(val: number): Float32Array {
  const a = new Float32Array(EMBEDDING_DIM);
  let s = (val * 0x9e3779b9) >>> 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    a[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  let n = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) n += a[i] * a[i];
  const norm = Math.sqrt(n) || 1;
  for (let i = 0; i < EMBEDDING_DIM; i++) a[i] /= norm;
  return a;
}

describe("encrypted-sidecar persistence (real graph)", () => {
  let dir: string;
  let usearchPath: string;
  let encPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sidecar-int-"));
    usearchPath = join(dir, "index.usearch");
    encPath = `${usearchPath}.enc`;
    db = createIndexDatabase(join(dir, `idx-${randomUUID()}.db`));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedChunks(count: number, startVal = 1): void {
    upsertChunks(
      db,
      Array.from({ length: count }, (_, i) => ({
        id: `c-${startVal + i}`,
        documentId: `doc-${startVal + i}`,
        chunkIndex: 0,
        content: `content ${startVal + i}`,
        embedding: embedding(startVal + i),
        sourceId: "test",
        title: `Doc ${startVal + i}`,
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      })),
    );
  }

  /**
   * Model the real flow: the indexer worker builds the graph from
   * chunks.embedding, flushes the PLAINTEXT sidecar (close() → save(), which
   * stamps `usearch_saved_seq`), then the gateway's shutdown encrypts that
   * plaintext into `.enc` using the SAVED seq — exactly what the file contains.
   */
  function buildAndSaveEncrypted(): number {
    const w = new UsearchWriteHandle(usearchPath, EMBEDDING_DIM);
    w.setOnSaved(() => setUsearchSavedSeq(db, getVectorWriteSeq(db)));
    w.backfillFromDb(db);
    const size = w.size();
    w.close(); // flush the plaintext graph, as the worker does at shutdown
    encryptSidecar(usearchPath, encPath, KEY, {
      vectorWriteSeq: getUsearchSavedSeq(db),
      embedModel: MODEL,
      embedDim: EMBEDDING_DIM,
    });
    return size;
  }

  /** Rebuild the graph from durable vectors after a restore was refused. */
  function rebuildFromVectors(expected: number): void {
    const w = new UsearchWriteHandle(usearchPath, EMBEDDING_DIM);
    w.backfillFromDb(db);
    expect(w.size()).toBe(expected);
    w.close();
  }

  it("saves an encrypted sidecar whose fingerprint matches the write-seq", () => {
    seedChunks(30);
    const size = buildAndSaveEncrypted();
    expect(size).toBe(30);
    expect(existsSync(encPath)).toBe(true);

    const fp = readSidecarFingerprint(encPath);
    expect(fp).not.toBeNull();
    // After a full save the saved-seq equals the live write-seq, so the sidecar's
    // fingerprint (stamped from usearch_saved_seq) equals vector_write_seq.
    expect(fp!.vectorWriteSeq).toBe(getVectorWriteSeq(db));
    expect(getUsearchSavedSeq(db)).toBe(getVectorWriteSeq(db));
    expect(fp!.embedModel).toBe(MODEL);
    expect(fp!.embedDim).toBe(EMBEDDING_DIM);
  });

  it("stamps usearch_saved_seq on save so the sidecar seq reflects the on-disk graph", () => {
    // The handle's onSaved hook is the fix's linchpin: it records the seq the
    // plaintext file was written at, independent of the shutdown path.
    expect(getUsearchSavedSeq(db)).toBe(0);
    seedChunks(10);
    const seqAfterInsert = getVectorWriteSeq(db);
    expect(getUsearchSavedSeq(db)).toBe(0); // an insert alone doesn't move it

    const w = new UsearchWriteHandle(usearchPath, EMBEDDING_DIM);
    w.setOnSaved(() => setUsearchSavedSeq(db, getVectorWriteSeq(db)));
    w.backfillFromDb(db); // builds + saves
    expect(getUsearchSavedSeq(db)).toBe(seqAfterInsert); // stamped by the save

    // A later insert with NO save leaves the saved-seq behind — exactly the
    // condition that makes the boot fingerprint check refuse a stale restore.
    seedChunks(3, 500);
    expect(getUsearchSavedSeq(db)).toBeLessThan(getVectorWriteSeq(db));
    w.close();
  });

  it("consistent restart restores the graph from .enc and skips the rebuild", () => {
    seedChunks(30);
    buildAndSaveEncrypted();
    // Simulate the encrypted-boot purge: the plaintext working file is gone.
    rmSync(usearchPath, { force: true });
    expect(existsSync(usearchPath)).toBe(false);
    expect(existsSync(encPath)).toBe(true);

    const restore = restoreActiveSidecar({
      encPath,
      plaintextPath: usearchPath,
      indexDbKey: KEY,
      expectedSeq: getVectorWriteSeq(db),
      expectedModel: { name: MODEL, dim: EMBEDDING_DIM },
    });
    expect(restore.restored).toBe(true);
    expect(existsSync(usearchPath)).toBe(true);

    // The worker opens the restored plaintext → count matches → backfill skips.
    const w = new UsearchWriteHandle(usearchPath, EMBEDDING_DIM);
    expect(w.size()).toBe(30); // loaded, NOT rebuilt
    w.close();

    // And it is a correct, searchable graph.
    const reader = UsearchReadHandle.open(usearchPath, EMBEDDING_DIM);
    const rowid5 = db
      .prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE document_id = ?")
      .get("doc-5")!.rowid;
    expect(reader.search(embedding(5), 1)[0].key).toBe(BigInt(rowid5));
    reader.close();
  });

  it("a restore re-stamps usearch_saved_seq so an idle re-shutdown can re-persist", () => {
    // Restore-boot skips the worker backfill (and thus its save + stamp). Boot
    // must therefore stamp usearch_saved_seq itself, or an idle gateway restarted
    // right after a restore would find it unset and skip the next encrypt.
    seedChunks(30);
    buildAndSaveEncrypted();
    const encSeq = readSidecarFingerprint(encPath)!.vectorWriteSeq;
    rmSync(usearchPath, { force: true });
    // Simulate a fresh boot on code that never stamped usearch_saved_seq.
    setUsearchSavedSeq(db, 0);

    const restore = restoreActiveSidecar({
      encPath,
      plaintextPath: usearchPath,
      indexDbKey: KEY,
      expectedSeq: getVectorWriteSeq(db),
      expectedModel: { name: MODEL, dim: EMBEDDING_DIM },
    });
    expect(restore.restored).toBe(true);
    // Boot stamps the restored seq (what `index.ts` now does).
    setUsearchSavedSeq(db, restore.seq!);
    expect(getUsearchSavedSeq(db)).toBe(encSeq);

    // A subsequent idle shutdown (no ingest) can now re-encrypt the restored
    // graph, so the NEXT boot restores again instead of rebuilding.
    rmSync(encPath, { force: true });
    encryptSidecar(usearchPath, encPath, KEY, {
      vectorWriteSeq: getUsearchSavedSeq(db),
      embedModel: MODEL,
      embedDim: EMBEDDING_DIM,
    });
    expect(readSidecarFingerprint(encPath)!.vectorWriteSeq).toBe(encSeq);
    rmSync(usearchPath, { force: true });
    const restore2 = restoreActiveSidecar({
      encPath,
      plaintextPath: usearchPath,
      indexDbKey: KEY,
      expectedSeq: getVectorWriteSeq(db),
      expectedModel: { name: MODEL, dim: EMBEDDING_DIM },
    });
    expect(restore2.restored).toBe(true);
  });

  it("write-seq desync (crash between commit and save) forces a rebuild, not a stale graph", () => {
    seedChunks(20);
    buildAndSaveEncrypted();
    const savedSeq = readSidecarFingerprint(encPath)!.vectorWriteSeq;

    // Simulate: new vectors committed to index.db, but the crash happened
    // before the next encrypted save() — so index.db's seq is ahead of the .enc.
    seedChunks(5, 100);
    expect(getVectorWriteSeq(db)).toBeGreaterThan(savedSeq);

    rmSync(usearchPath, { force: true });
    const restore = restoreActiveSidecar({
      encPath,
      plaintextPath: usearchPath,
      indexDbKey: KEY,
      expectedSeq: getVectorWriteSeq(db),
      expectedModel: { name: MODEL, dim: EMBEDDING_DIM },
    });
    expect(restore.restored).toBe(false);
    expect(restore.reason).toMatch(/write-seq mismatch/);
    // No plaintext materialised → the worker starts empty → backfill REBUILDS.
    expect(existsSync(usearchPath)).toBe(false);
    const w = new UsearchWriteHandle(usearchPath, EMBEDDING_DIM);
    expect(w.size()).toBe(0);
    w.backfillFromDb(db);
    expect(w.size()).toBe(25); // rebuilt from ALL 25 durable vectors
    w.close();
  });

  it("a shutdown flush-save after un-saved ingest re-persists the sidecar so the next boot RESTORES", () => {
    // The gap the shutdown flush-save closes: vectors are committed to index.db
    // AND added to the in-memory graph, but the last plaintext save() was earlier,
    // so usearch_saved_seq lags the live seq. Without a final save the encrypt
    // captures the stale seq and the next boot rebuilds (the desync case above).
    // The flush-save forces that final save, so the on-disk graph + seq are
    // current and the boot restores instead.
    const w = new UsearchWriteHandle(usearchPath, EMBEDDING_DIM);
    w.setOnSaved(() => setUsearchSavedSeq(db, getVectorWriteSeq(db)));
    seedChunks(20);
    w.backfillFromDb(db); // builds + saves at the initial seq
    expect(getUsearchSavedSeq(db)).toBe(getVectorWriteSeq(db));

    // Later ingest lands in index.db AND the in-memory graph, but is NOT saved
    // to disk — the exact pre-shutdown state that used to force a rebuild.
    seedChunks(5, 100);
    for (let i = 0; i < 5; i++) {
      const rowid = db
        .prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE document_id = ?")
        .get(`doc-${100 + i}`)!.rowid;
      w.add(BigInt(rowid), embedding(100 + i));
    }
    expect(getUsearchSavedSeq(db)).toBeLessThan(getVectorWriteSeq(db)); // stale

    // What handleFlushSave does at shutdown: a final save() (dirty → writes the
    // graph + stamps the seq via onSaved). Now saved-seq == live seq.
    w.save();
    expect(getUsearchSavedSeq(db)).toBe(getVectorWriteSeq(db));
    w.close();

    // The gateway then encrypts using the now-current saved seq.
    encryptSidecar(usearchPath, encPath, KEY, {
      vectorWriteSeq: getUsearchSavedSeq(db),
      embedModel: MODEL,
      embedDim: EMBEDDING_DIM,
    });

    // Next boot purges the plaintext and restores — the fingerprint now MATCHES
    // the live db seq (contrast the desync test, which refuses and rebuilds).
    rmSync(usearchPath, { force: true });
    const restore = restoreActiveSidecar({
      encPath,
      plaintextPath: usearchPath,
      indexDbKey: KEY,
      expectedSeq: getVectorWriteSeq(db),
      expectedModel: { name: MODEL, dim: EMBEDDING_DIM },
    });
    expect(restore.restored).toBe(true); // RESTORED, not rebuilt — the fix's payoff

    // All 25 vectors (20 + 5 un-saved-then-flushed) are present and searchable.
    const reader = UsearchReadHandle.open(usearchPath, EMBEDDING_DIM);
    expect(reader.size()).toBe(25);
    const rowid102 = db
      .prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE document_id = ?")
      .get("doc-102")!.rowid;
    expect(reader.search(embedding(102), 1)[0].key).toBe(BigInt(rowid102));
    reader.close();
  });

  it("a tampered .enc is rejected and deleted, forcing a rebuild", () => {
    seedChunks(20);
    buildAndSaveEncrypted();
    rmSync(usearchPath, { force: true });
    // Flip a ciphertext byte.
    const buf = readFileSync(encPath);
    buf[buf.length - 40] ^= 0xff;
    writeFileSync(encPath, buf);

    const restore = restoreActiveSidecar({
      encPath,
      plaintextPath: usearchPath,
      indexDbKey: KEY,
      expectedSeq: getVectorWriteSeq(db),
      expectedModel: { name: MODEL, dim: EMBEDDING_DIM },
    });
    expect(restore.restored).toBe(false);
    expect(restore.reason).toMatch(/decrypt failed/);
    expect(existsSync(usearchPath)).toBe(false);
    expect(existsSync(encPath)).toBe(false); // bad .enc dropped so next boot rebuilds
    rebuildFromVectors(20); // and the rebuild yields the correct, complete graph
  });

  it("embedder stamp mismatch forces a rebuild (defense in depth)", () => {
    seedChunks(10);
    buildAndSaveEncrypted();
    rmSync(usearchPath, { force: true });
    const restore = restoreActiveSidecar({
      encPath,
      plaintextPath: usearchPath,
      indexDbKey: KEY,
      expectedSeq: getVectorWriteSeq(db),
      expectedModel: { name: "some-other-model", dim: EMBEDDING_DIM },
    });
    expect(restore.restored).toBe(false);
    expect(restore.reason).toMatch(/stamp mismatch/);
    expect(existsSync(usearchPath)).toBe(false);
    rebuildFromVectors(10);
  });

  it("wrong key is rejected, forcing a rebuild", () => {
    seedChunks(10);
    buildAndSaveEncrypted();
    rmSync(usearchPath, { force: true });
    const restore = restoreActiveSidecar({
      encPath,
      plaintextPath: usearchPath,
      indexDbKey: randomBytes(32), // different key
      expectedSeq: getVectorWriteSeq(db),
      expectedModel: { name: MODEL, dim: EMBEDDING_DIM },
    });
    expect(restore.restored).toBe(false);
    expect(existsSync(usearchPath)).toBe(false);
    rebuildFromVectors(10);
  });

  it("the write handle is plaintext-only — close() never writes an encrypted sidecar", () => {
    // The load-bearing "encryption OFF → unchanged" invariant: the handle itself
    // has no encryption awareness. Producing `.enc` is solely the gateway
    // shutdown's job (encryptSidecar), gated on storage encryption being on.
    seedChunks(10);
    const w = new UsearchWriteHandle(usearchPath, EMBEDDING_DIM);
    w.backfillFromDb(db);
    w.close();
    expect(existsSync(usearchPath)).toBe(true); // plaintext graph flushed
    expect(existsSync(encPath)).toBe(false); // but NO encrypted sidecar
  });
});
