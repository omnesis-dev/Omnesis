// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { MessageChannel } from "node:worker_threads";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMBEDDING_DIM,
  createIndexDatabase,
  getUsearchBackfillCursor,
  getUsearchEncoding,
  getUsearchSavedChangeSeq,
  getVectorChangeHead,
  setIndexEmbedModel,
  upsertChunks,
} from "./db.js";
import { GraphKeeper, planGraphAdmission } from "./graph-keeper.js";
import { UsearchWriteHandle } from "./usearch-index.js";
import { readSidecarFingerprint } from "./usearch-sidecar-crypto.js";
import type { SemanticSearchStatus } from "@omnesis/source-sdk";
import type Database from "better-sqlite3";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function embedding(seed: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  v[seed % EMBEDDING_DIM] = 1;
  v[(seed * 7 + 3) % EMBEDDING_DIM] += 0.5;
  return v;
}

describe("planGraphAdmission", () => {
  const budget = { bytes: 4 * GIB, source: "cgroup" as const };

  it("admits a graph that fits with the reserve to spare", () => {
    expect(
      planGraphAdmission({ vectors: 100_000, dim: 768, budget, headroom: 3 * GIB, loading: false }),
    ).toEqual({ admitted: true });
  });

  it("refuses one that does not, naming the sizes and the budget's origin", () => {
    const plan = planGraphAdmission({
      vectors: 500_000,
      dim: 1024,
      budget,
      headroom: 2 * GIB,
      loading: false,
      encoding: "f32",
    });
    expect(plan.admitted).toBe(false);
    expect(!plan.admitted && plan.reason).toMatch(
      /needs about 2\.8 GiB and 2\.0 GiB of the 4\.0 GiB \(container memory limit\) memory budget is free/,
    );
  });

  it("sizes a graph loaded from a complete file at its load cost, not its build cost", () => {
    // 1.8 GiB to load plus the 819 MiB reserve fits in 3 GiB; the 2.3 GiB build does not.
    const fits = {
      vectors: 400_000,
      dim: 1024,
      budget,
      headroom: 3 * GIB,
      encoding: "f32" as const,
    };
    expect(planGraphAdmission({ ...fits, loading: true })).toEqual({ admitted: true });
    expect(planGraphAdmission({ ...fits, loading: false }).admitted).toBe(false);
  });

  it("sizes a binary graph by its bit codes, so one that floats could not hold fits", () => {
    // 5.6M vectors at 768 dims: about 24 GiB built as floats, 2.6 GiB as one bit a dimension.
    const corpus = { vectors: 5_600_000, dim: 768, budget, headroom: 3.8 * GIB, loading: false };
    expect(planGraphAdmission({ ...corpus, encoding: "f32" }).admitted).toBe(false);
    expect(planGraphAdmission({ ...corpus, encoding: "b1" })).toEqual({ admitted: true });
    expect(planGraphAdmission(corpus)).toEqual({ admitted: true });
  });

  it("keeps a bounded reserve on a large host instead of a fifth of its memory", () => {
    const large = { bytes: 128 * GIB, source: "host" as const };
    expect(
      planGraphAdmission({
        vectors: 500_000,
        dim: 1024,
        budget: large,
        headroom: 8 * GIB,
        loading: false,
      }),
    ).toEqual({ admitted: true });
  });

  it("says so when the gateway already uses its whole budget", () => {
    const plan = planGraphAdmission({
      vectors: 1_000,
      dim: 1024,
      budget,
      headroom: -100 * MIB,
      loading: false,
    });
    expect(!plan.admitted && plan.reason).toMatch(/already uses all of its 4\.0 GiB/);
  });
});

describe("GraphKeeper", () => {
  let dir: string;
  let path: string;
  let db: Database.Database;
  let headroom: number;
  let states: SemanticSearchStatus[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "graph-keeper-"));
    path = join(dir, "index.usearch");
    db = createIndexDatabase(join(tmpdir(), `omnesis-graph-keeper-${randomUUID()}.db`));
    setIndexEmbedModel(db, "test-embedder", EMBEDDING_DIM);
    headroom = 8 * GIB;
    states = [];
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(from: number, to: number): void {
    upsertChunks(
      db,
      Array.from({ length: to - from }, (_, i) => ({
        id: `chunk-${from + i}`,
        documentId: `doc-${from + i}`,
        chunkIndex: 0,
        content: `Fictional field note ${from + i}`,
        embedding: embedding(from + i + 1),
        sourceId: "test-source",
        title: `Note ${from + i}`,
        sourceCreatedAt: "2026-03-10T00:00:00Z",
      })),
    );
  }

  function start(
    opts: {
      indexDbKey?: Buffer;
      pageSize?: number;
      headroom?: () => number;
      canGrow?: () => boolean;
      onProgress?: (fraction: number) => void;
    } = {},
  ): {
    keeper: GraphKeeper;
    handle: UsearchWriteHandle;
  } {
    const graphFileExisted = existsSync(path);
    const handle = new UsearchWriteHandle(path, EMBEDDING_DIM);
    const keeper = new GraphKeeper({
      indexDb: db,
      handle,
      graphPath: path,
      graphFileExisted,
      indexDbKey: opts.indexDbKey ?? null,
      budget: { bytes: 8 * GIB, source: "config" },
      pageSize: opts.pageSize,
      canGrow: opts.canGrow,
      headroom: opts.headroom ?? (() => headroom),
      onProgress: opts.onProgress ?? (() => {}),
      onState: (state) => states.push(state),
      log: () => {},
    });
    return { keeper, handle };
  }

  it("does not checkpoint a storage-blocked graph and resumes after capacity returns", async () => {
    seed(0, 5);
    let allowed = false;
    const { keeper, handle } = start({ canGrow: () => allowed });
    await keeper.open();
    expect(existsSync(path)).toBe(false);
    expect(handle.isDetached).toBe(false);
    expect(await keeper.resumeStorageWork()).toBe(false);
    allowed = true;
    expect(await keeper.resumeStorageWork()).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(states.at(-1)).toMatchObject({ state: "ready" });
    keeper.stop();
    handle.release();
  });

  it.each(["fresh", "blocked", "missing"] as const)(
    "checks the %s capacity lease delivered after a slow native count before completing graph recovery",
    async (update) => {
      seed(0, 5);
      const initial = start();
      await initial.keeper.open();
      initial.keeper.stop();
      initial.handle.release();
      states.length = 0;
      const saved = readFileSync(path);
      const leaseMs = 120_000;
      let now = Date.now();
      let validUntil = now + leaseMs;
      let blocked = false;
      const { keeper, handle } = start({ canGrow: () => !blocked && now < validUntil });
      const prepare = db.prepare.bind(db);
      let counts = 0;
      let updates = 0;
      const { port1, port2 } = new MessageChannel();
      port1.on("message", () => {
        updates++;
        blocked = update === "blocked";
        validUntil = now + leaseMs;
      });
      // Run the real SQLite/native graph paths. Only elapsed time and the queued
      // capacity message are substituted, so the fixture needs no large payload.
      const intercepted = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
        const statement = prepare(sql);
        if (/SELECT count\(\*\) as cnt FROM chunks WHERE embedding IS NOT NULL/.test(sql)) {
          const get = statement.get.bind(statement);
          vi.spyOn(statement, "get").mockImplementation((...args: unknown[]) => {
            const result = get(...args);
            counts++;
            now += leaseMs + 1;
            if (update !== "missing") port2.postMessage("capacity updated");
            return result;
          });
        }
        return statement;
      }) as typeof db.prepare);
      try {
        await keeper.open();
        if (update === "fresh") {
          // Repeatedly running the same cold count must not expire a fresh
          // message again: one recovery attempt is enough for a complete graph.
          for (let attempt = 0; attempt < 2 && states.at(-1)?.state !== "ready"; attempt++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            await keeper.resumeStorageWork();
          }
          expect(counts).toBe(1);
          expect(states.at(-1)).toMatchObject({ state: "ready" });
          expect(updates).toBe(1);
        } else {
          expect(states.at(-1)).toMatchObject({
            state: "degraded",
            reason: expect.stringContaining("Storage capacity"),
          });
          expect(readFileSync(path)).toEqual(saved);
          expect(await keeper.resumeStorageWork()).toBe(false);
          expect(counts).toBe(1);
        }
      } finally {
        intercepted.mockRestore();
        port1.close();
        port2.close();
        keeper.stop();
        handle.release();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
  );

  it("does not force a checkpoint when storage blocks a graph build mid-page", async () => {
    seed(0, 10);
    let allowed = true;
    let firstPage = true;
    const { keeper, handle } = start({
      pageSize: 2,
      canGrow: () => allowed,
      onProgress: () => {
        if (firstPage) {
          firstPage = false;
          allowed = false;
        }
      },
    });
    await keeper.open();
    expect(existsSync(path)).toBe(false);
    expect(handle.backfillCursor).not.toBeNull();
    allowed = true;
    expect(await keeper.resumeStorageWork()).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(states.at(-1)).toMatchObject({ state: "ready" });
    keeper.stop();
    handle.release();
  });

  it("keeps a stored graph untouched while storage is blocked", async () => {
    seed(0, 5);
    const initial = start();
    await initial.keeper.open();
    initial.keeper.stop();
    initial.handle.release();
    const before = readFileSync(path);
    seed(5, 10);
    const deferred = start({ canGrow: () => false });
    await deferred.keeper.open();
    expect(readFileSync(path)).toEqual(before);
    deferred.keeper.stop();
    deferred.handle.release();
  });

  it("stamps the saved graph's encoding, which reads as floats until a save", async () => {
    seed(0, 5);
    expect(getUsearchEncoding(db)).toBe("f32");
    const { keeper, handle } = start();
    await keeper.open();
    expect(getUsearchEncoding(db)).toBe(handle.encoding);
    expect(getUsearchEncoding(db)).toBe("b1");
  });

  it("sheds the graph when headroom runs short, and a restart catches it up", async () => {
    seed(0, 20);
    const first = start();
    await first.keeper.open();
    expect(states.at(-1)).toEqual({ state: "ready" });

    seed(20, 25);
    headroom = 100 * MIB;
    first.keeper.shedIfShort();
    expect(first.handle.isDetached).toBe(true);
    expect(states.at(-1)?.state).toBe("degraded");
    expect(states.at(-1)?.reason).toMatch(/memory ran short while serving: 100 MiB left/);
    // Vectors written after the release wait in the log for the next start.
    seed(25, 30);

    headroom = 8 * GIB;
    const second = start();
    await second.keeper.open();
    expect(states.at(-1)).toEqual({ state: "ready" });
    expect(second.handle.size()).toBe(30);
  });

  it("stops a rebuild when headroom runs short and resumes it on the next start", async () => {
    seed(0, 40);
    let pages = 0;
    const first = start({ pageSize: 5, headroom: () => (++pages > 4 ? 100 * MIB : 8 * GIB) });
    await first.keeper.open();
    expect(states.at(-1)?.state).toBe("degraded");
    expect(states.at(-1)?.reason).toMatch(/while building the graph/);
    const cursor = getUsearchBackfillCursor(db);
    expect(cursor).not.toBeNull();

    const second = start({ pageSize: 5 });
    await second.keeper.open();
    expect(states.at(-1)).toEqual({ state: "ready" });
    expect(second.handle.size()).toBe(40);
    expect(getUsearchBackfillCursor(db)).toBeNull();
  });

  it("an encrypted install's checkpoint carries the graph's log position", async () => {
    seed(0, 10);
    const key = randomBytes(32);
    const { keeper } = start({ indexDbKey: key });
    await keeper.open();
    const header = readSidecarFingerprint(`${path}.enc`);
    expect(header?.changeSeq).toBe(getVectorChangeHead(db));
    expect(header?.backfillCursor).toBeUndefined();
    // The log below the persisted graph is no longer needed.
    expect(db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM vector_changes").get()?.c).toBe(
      0,
    );
  });

  it("does not stamp past a main-thread removal the graph has not applied yet", async () => {
    seed(0, 5);
    const { keeper, handle } = start();
    await keeper.open();
    const stamped = getUsearchSavedChangeSeq(db);
    db.prepare("DELETE FROM chunks WHERE id = ?").run("chunk-0");
    db.prepare("INSERT INTO pending_vector_deletes (chunk_rowid, generation) VALUES (1, 1)").run();
    seed(5, 6);
    handle.add(BigInt(6), embedding(6));
    handle.save();
    expect(getUsearchSavedChangeSeq(db)).toBe(stamped);
  });
});
