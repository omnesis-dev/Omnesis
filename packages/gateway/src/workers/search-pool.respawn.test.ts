// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A search worker that dies is replaced — bounded, and with the pool serving
 * from its live workers meanwhile.
 *
 * The respawn tests drive a real `search-worker.ts` thread through the pool.
 * The crash is `Worker.terminate()` on the slot's thread, the only way to end
 * a worker from outside it; what follows — the exit event, the respawn timer,
 * the replacement's init and `ready` — is the pool's own machinery. The boot
 * window and the in-flight call need what a healthy real worker cannot be
 * made to do from outside — a slot that is ready while its sibling is still
 * loading, a slot that never comes up, a call that is never answered — so
 * those tests script a stand-in that speaks the pool's protocol; the pool
 * under test is the same. Its observables are `isReady`, `start()`'s and
 * `candidateGen`'s settlement, and its log lines, captured through the
 * structured logger's file sink.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LogLevel, resolveWorkerEntry, setLogFile, setLogLevel } from "@omnesis/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  EMBEDDING_DIM,
  createIndexDatabase,
  setIndexedDocument,
  upsertChunks,
} from "../indexer/db.js";
import {
  resolveDiversityConfig,
  resolveSearchSettings,
  resolveSourcePriorsConfig,
  resolveVectorConfig,
} from "../search/search-config.js";
import { SearchWorkerPool } from "./search-pool.js";
import type { Worker } from "node:worker_threads";
import type { CandidateGenRequest } from "../search/candidate-gen.js";

const SEARCH_WORKER = resolveWorkerEntry(
  "./search-worker.ts",
  import.meta.url,
  "./register-tsx.mjs",
);

const RESPAWN_LINE = "respawning in";
const RESPAWNED_LINE = "respawned and ready";
const GIVE_UP_LINE = "not respawning it again";

function seedIndexDb(path: string): void {
  const db = createIndexDatabase(path);
  upsertChunks(db, [
    {
      id: "chunk-1",
      documentId: "doc-1",
      chunkIndex: 0,
      content: "Harbour dredging schedule for the Wexley marina refit",
      embedding: new Float32Array(EMBEDDING_DIM),
      sourceId: "synthetic:test@example.com",
      documentType: "note",
      title: "Marina refit",
      sourceCreatedAt: "2026-02-11T09:00:00Z",
    },
  ]);
  setIndexedDocument(db, "doc-1", "hash-1", 1);
  db.close();
}

/** BM25 only — no embedder, so the request needs no model. */
function request(): CandidateGenRequest {
  const settings = resolveSearchSettings(undefined);
  return {
    mode: "hybrid",
    bm25Text: "dredging",
    embedderPresent: false,
    queryVector: null,
    embedMs: 0,
    queryModelId: null,
    filters: {},
    allowedDocumentIds: undefined,
    candidateLimit: settings.params.candidateLimit,
    limit: settings.params.resultLimit,
    settings,
    vectorConfig: resolveVectorConfig(undefined),
    sourcePriors: resolveSourcePriorsConfig(
      undefined,
      {},
      { docCounts: [], rrfK: settings.params.rrfK },
    ),
    diversity: resolveDiversityConfig(undefined),
    commonTokenThreshold: 0.1,
  };
}

/**
 * A stand-in for `search-worker.ts`, built from a data: URL so no file is
 * needed: it answers `shutdown` like the real worker, and its `init` and
 * `call` handlers are the scenario's own statements (`post` sends to the pool).
 */
function scriptedWorker(handlers: { onInit: string; onCall?: string }): URL {
  const source = `
    import { parentPort } from "node:worker_threads";
    import { existsSync, mkdirSync } from "node:fs";
    const post = (msg) => parentPort.postMessage(msg);
    parentPort.on("message", (msg) => {
      switch (msg.type) {
        case "init": { ${handlers.onInit} break; }
        case "call": { ${handlers.onCall ?? ""} break; }
        case "shutdown": post({ type: "shutdownComplete" }); break;
      }
    });`;
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

/**
 * An `init` handler under which the first worker to claim `claimDir` reports
 * ready at once and every later one — the sibling slot, and any replacement —
 * reports ready only once `gate` exists. This is the boot window held open:
 * one slot up, the other still loading, until the test releases it.
 */
function readyFirstThenGated(claimDir: string, gate: string): string {
  return `
    let first = false;
    try { mkdirSync(${JSON.stringify(claimDir)}); first = true; } catch {}
    if (first) { post({ type: "ready" }); }
    else {
      const poll = setInterval(() => {
        if (!existsSync(${JSON.stringify(gate)})) return;
        clearInterval(poll);
        post({ type: "ready" });
      }, 10);
    }`;
}

type Slots = Array<{ worker: Worker | null; ready: boolean }>;

/** The pool keeps its slots private; a crash and the boot window have no other entry point. */
function slotsOf(pool: SearchWorkerPool): Slots {
  return (pool as unknown as { slots: Slots }).slots;
}

function workerOf(pool: SearchWorkerPool, slot: number): Worker {
  const worker = slotsOf(pool)[slot]!.worker;
  if (!worker) throw new Error(`slot ${slot} has no live worker`);
  return worker;
}

function readySlots(pool: SearchWorkerPool): number[] {
  return slotsOf(pool).flatMap((s, i) => (s.ready ? [i] : []));
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("SearchWorkerPool respawn", () => {
  let dir: string;
  let dbPath: string;
  let logPath: string;
  let pool: SearchWorkerPool | undefined;

  const poolLog = (): string => readFileSync(logPath, "utf8");

  const makePool = (extra: Partial<ConstructorParameters<typeof SearchWorkerPool>[0]> = {}) =>
    new SearchWorkerPool({
      indexDbPath: dbPath,
      configDir: dir,
      concurrency: 1,
      maxInflightBeforeFallback: 4,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: SEARCH_WORKER.url,
      workerExecArgv: SEARCH_WORKER.execArgv,
      respawnBaseDelayMs: 10,
      respawnMaxDelayMs: 40,
      ...extra,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-swrespawn-"));
    dbPath = join(dir, "index.db");
    logPath = join(dir, "pool.log");
    seedIndexDb(dbPath);
    setLogLevel(LogLevel.INFO);
    setLogFile(logPath);
  });

  afterEach(async () => {
    setLogFile(null);
    await pool?.dispose();
    pool = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a crashed worker is respawned and the next query is served by a worker again", async () => {
    pool = makePool();
    await pool.start();
    const before = await pool.candidateGen(request());
    expect(before.results.length).toBeGreaterThan(0);

    await workerOf(pool, 0).terminate();
    expect(pool.isReady).toBe(false);

    await waitFor("the pool to become ready again after the crash", () => pool!.isReady);
    expect(poolLog()).toContain(RESPAWNED_LINE);

    const after = await pool.candidateGen(request());
    expect(after.results).toEqual(before.results);
  });

  test("a worker that dies every time it comes back is respawned a bounded number of times, then abandoned with one line", async () => {
    pool = makePool({ maxRespawnStreak: 2 });
    await pool.start();

    // Every replacement will fail to open its handle.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    await workerOf(pool, 0).terminate();

    await waitFor("the pool to give up on the slot", () => poolLog().includes(GIVE_UP_LINE));
    const log = poolLog();
    expect(count(log, RESPAWN_LINE)).toBe(2);
    expect(count(log, GIVE_UP_LINE)).toBe(1);
    expect(log).toContain("crash 1/2");
    expect(log).toContain("crash 2/2");
    expect(pool.isReady).toBe(false);
    await expect(pool.candidateGen(request())).rejects.toThrow(/no search worker is ready/);
  });

  test("a crash after a stable stretch of service starts a fresh streak", async () => {
    // With no service required between crashes, every crash is streak 1: the
    // cap of one respawn per streak never trips.
    pool = makePool({ maxRespawnStreak: 1, respawnStableMs: 0 });
    await pool.start();

    for (let crash = 1; crash <= 2; crash++) {
      await workerOf(pool, 0).terminate();
      await waitFor(`the pool to come back after crash ${crash}`, () => pool!.isReady);
      expect(count(poolLog(), RESPAWNED_LINE)).toBe(crash);
    }
    expect(poolLog()).not.toContain(GIVE_UP_LINE);
    expect((await pool.candidateGen(request())).results.length).toBeGreaterThan(0);
  });

  test("with two workers the survivor keeps serving while its sibling is replaced", async () => {
    pool = makePool({ concurrency: 2, respawnBaseDelayMs: 500, respawnMaxDelayMs: 500 });
    await pool.start();

    await workerOf(pool, 0).terminate();
    await waitFor("the crash to be observed", () => poolLog().includes(RESPAWN_LINE));
    // Slot 0 is down and its replacement has not been spawned yet; slot 1 answers.
    expect(pool.isReady).toBe(true);
    expect((await pool.candidateGen(request())).results.length).toBeGreaterThan(0);

    await waitFor("slot 0 to come back", () => poolLog().includes(RESPAWNED_LINE));
  });

  test("the query in flight when the worker dies fails at once, never hangs", async () => {
    // The worker takes the call and never answers it, so only the crash can
    // settle the call.
    pool = makePool({
      workerUrl: scriptedWorker({ onInit: `post({ type: "ready" });` }),
      workerExecArgv: [],
    });
    await pool.start();

    const inFlight = pool.candidateGen(request());
    await workerOf(pool, 0).terminate();
    await expect(inFlight).rejects.toThrow(/search worker exited/);
    expect(pool.isReady).toBe(false);
  });

  describe("the boot window", () => {
    /**
     * Two slots; one is ready and the other still loading when the ready
     * one's worker dies by `crash`. The pool must schedule the replacement
     * without waiting for `start()`, and `start()` must resolve once the
     * loading slot comes up — not hang on the slot that died, nor reject
     * for a worker that had already served.
     */
    async function crashedBeforeStartSettled(
      workerUrl: URL,
      crash: (worker: Worker) => Promise<void>,
    ): Promise<void> {
      pool = makePool({ concurrency: 2, workerUrl, workerExecArgv: [] });
      const started = pool.start();
      await waitFor("one slot to report ready", () => pool!.isReady);
      const [readySlot, ...others] = readySlots(pool);
      expect(others, "the sibling slot is still loading").toEqual([]);

      await crash(workerOf(pool, readySlot!));
      await waitFor("the dead slot's respawn to be scheduled", () =>
        poolLog().includes(RESPAWN_LINE),
      );
      expect(pool.isReady).toBe(false);

      writeFileSync(join(dir, "gate"), "");
      await started;
      await waitFor("the dead slot to come back", () => poolLog().includes(RESPAWNED_LINE));
      expect(readySlots(pool)).toEqual([0, 1]);
    }

    test("a ready slot whose worker exits before start() has settled is respawned, and start() resolves once its sibling is up", async () => {
      const workerUrl = scriptedWorker({
        onInit: readyFirstThenGated(join(dir, "claim"), join(dir, "gate")),
      });
      await crashedBeforeStartSettled(workerUrl, (worker) => worker.terminate().then(() => {}));
    }, 20_000);

    test("a ready slot whose worker faults before start() has settled is respawned, and start() resolves once its sibling is up", async () => {
      const workerUrl = scriptedWorker({
        onInit: readyFirstThenGated(join(dir, "claim"), join(dir, "gate")),
        onCall: `throw new Error("scripted fault");`,
      });
      await crashedBeforeStartSettled(workerUrl, async () => {
        // The fault reaches the pool as the worker's `error` event, then its exit.
        await pool!.candidateGen(request()).catch(() => {});
      });
    }, 20_000);

    test("a slot that never comes up and exits rejects start(), and is not respawned", async () => {
      pool = makePool({
        workerUrl: scriptedWorker({ onInit: `process.exit(3);` }),
        workerExecArgv: [],
      });
      await expect(pool.start()).rejects.toThrow(/exited code=3 before reporting ready/);
      expect(pool.isReady).toBe(false);
      expect(poolLog()).not.toContain(RESPAWN_LINE);
    });
  });

  test("dispose while a respawn is pending cancels it", async () => {
    pool = makePool({ respawnBaseDelayMs: 500, respawnMaxDelayMs: 500 });
    await pool.start();
    await workerOf(pool, 0).terminate();
    await waitFor("the crash to be observed", () => poolLog().includes(RESPAWN_LINE));

    await pool.dispose();
    expect(pool.isDisposed).toBe(true);
    // The timer is cleared, so no worker boots after dispose; a spawn would
    // log its own ready line, and none appears.
    await new Promise((r) => setTimeout(r, 800));
    expect(poolLog()).not.toContain(RESPAWNED_LINE);
    pool = undefined;
  });
});
