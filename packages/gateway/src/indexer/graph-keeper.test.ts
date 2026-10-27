// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EMBEDDING_DIM,
  createIndexDatabase,
  getUsearchBackfillCursor,
  getUsearchSavedChangeSeq,
  getVectorChangeHead,
  setIndexEmbedModel,
  upsertChunks,
} from "./db.js";
import { GraphKeeper, planGraphAdmission } from "./graph-keeper.js";
import type { SemanticSearchStatus } from "@omnesis/source-sdk";
import { UsearchWriteHandle } from "./usearch-index.js";
import { readSidecarFingerprint } from "./usearch-sidecar-crypto.js";
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
    });
    expect(plan.admitted).toBe(false);
    expect(!plan.admitted && plan.reason).toMatch(
      /needs about 2\.8 GiB and 2\.0 GiB of the 4\.0 GiB \(container memory limit\) memory budget is free/,
    );
  });

  it("sizes a graph loaded from a complete file at its load cost, not its build cost", () => {
    // 1.8 GiB to load plus the 819 MiB reserve fits in 3 GiB; the 2.3 GiB build does not.
    const fits = { vectors: 400_000, dim: 1024, budget, headroom: 3 * GIB };
    expect(planGraphAdmission({ ...fits, loading: true })).toEqual({ admitted: true });
    expect(planGraphAdmission({ ...fits, loading: false }).admitted).toBe(false);
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
    db = createIndexDatabase(`/tmp/omnesis-graph-keeper-${randomUUID()}.db`);
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

  function start(opts: { indexDbKey?: Buffer; pageSize?: number; headroom?: () => number } = {}): {
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
      headroom: opts.headroom ?? (() => headroom),
      onProgress: () => {},
      onState: (state) => states.push(state),
      log: () => {},
    });
    return { keeper, handle };
  }

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
