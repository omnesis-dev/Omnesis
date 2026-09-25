// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Near-duplicate batching and document-frequency generations, end to end on a
 * real gateway.
 *
 * Detection is a pipeline, not a function. A document is signed against the
 * corpus-wide document-frequency table, its sixteen LSH band hashes are
 * persisted, and a later document finds it by hashing into one of the same
 * buckets. Everything the operator sees — the similar-documents panel, the
 * agent's neighbour list — is the output of those steps composing across
 * time: across compute ticks, and across a whole-corpus re-sign.
 *
 * Unit tests cover each step against fixtures, and `near-dup-df.e2e.test.ts`
 * covers the shape of a DF build — a complete table, a stable second build,
 * no staging file left behind. Neither asserts a single edge. What only a
 * real gateway can show is whether the promise survives the composition:
 *
 *   - A cluster larger than one compute batch ends up fully connected. The
 *     in-batch band index connects siblings drained in the same tick; only
 *     the persisted bucket rows connect a document to a sibling drained in an
 *     earlier one. Both halves have to work, and the second half is the one
 *     that produced partially-connected clusters on a large bootstrap.
 *
 *   - Re-signing the whole corpus reproduces the graph it already had. The
 *     boot-time algorithm bump enqueues every eligible document while the
 *     bucket table is empty, so for the length of that drain each document
 *     sees only the fraction of the corpus signed before it. It is the one
 *     window where a recall defect and a writer defect compound, and it is
 *     invisible afterwards because the inbox rows are consumed.
 *
 *   - A document's candidate index still means what it meant when it was
 *     written. Band hashes are a function of the DF table, the DF table is
 *     rebuilt whole, and the bucket rows are keyed by algorithm version
 *     alone. That last one does not hold today; the test that states it is
 *     skipped, and carries the evidence and the trade-off.
 *
 * The setup is arranged so nothing in the file waits on a clock. Automatic
 * compute is parked and every tick is one this file asked for; the DF table
 * rebuilds only when a file-like document has arrived since the last build,
 * which happens exactly where the file pushes one. `computeBatchSize` is
 * pinned to two so a six-document cluster cannot be drained in one tick, and
 * `beforeAll` records how many of the cluster carried a signature after each
 * tick — the evidence the first test needs that the cluster really did span
 * batches rather than being connected entirely in memory.
 *
 * Why `e2e-minimal`: every fixture this file cares about is pushed by the
 * test. The universe supplies an ambient corpus for the weighting to be
 * computed over, and nothing else; a larger one would cost minutes to say
 * the same thing.
 *
 * Tests run in declared order and later tests build on earlier state: the
 * second re-signs the corpus the first drained, and the third grows it.
 */

import "./synth-env.js";
import SqliteDatabase from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { waitForCondition } from "./multi-collector-harness.js";

/** Long enough that automatic compute never races the hand-driven ticks. */
const PARKED_PERIOD_MS = 999_999_999;

/** Pinned rather than inherited — the fixture sizes are chosen against it. */
const MIN_CONTENT_LENGTH = 200;
const MAX_CONTENT_LENGTH = 2_000_000;

/**
 * Two documents per compute tick. Six near-identical documents then cannot
 * be connected by the in-batch band index alone, which is the whole point of
 * the first test.
 */
const COMPUTE_BATCH_SIZE = 2;

const CLIQUE_SIZE = 6;
const BALLAST_SIZE = 6;
const BODY_WORDS = 600;
const BALLAST_WORDS = 400;

/** The types the DF scan and the algo-bump enqueue both select on. */
const ELIGIBLE_DOC_TYPES = [
  "email",
  "attachment",
  "file",
  "document",
  "note",
  "conversation",
] as const;

/**
 * Above `SQL_ROW_CAP` (10_000) so an over-large result sets `truncated`
 * rather than being clipped in silence. Every set comparison here also
 * cross-checks its row count against a `COUNT(*)`.
 */
const SQL_LIMIT = 100_000;

/** An algorithm version the code does not declare, to stage a bump. */
const PRIOR_ALGO_VERSION = "e2e-prior-algo";

/**
 * Thirty-two invented tokens. Bodies are drawn from them by a seeded
 * generator, so every signature, band hash and gate decision in this file is
 * byte-identical on every run and on any machine.
 */
const WORDS = [
  "alpha",
  "bravo",
  "cobalt",
  "delta",
  "ember",
  "fjord",
  "granite",
  "harbor",
  "indigo",
  "juniper",
  "kestrel",
  "lantern",
  "meridian",
  "nocturne",
  "opaline",
  "pewter",
  "quarry",
  "ripple",
  "slate",
  "tundra",
  "umbra",
  "verdant",
  "willow",
  "xenon",
  "yarrow",
  "zephyr",
  "basalt",
  "cinder",
  "elmwood",
  "glimmer",
  "jasper",
  "rowan",
] as const;

/** Tail words that appear in exactly one clique member each. */
const VARIANT_TAILS = ["alfa", "bex", "cyra", "dov", "eik", "fyn"] as const;

/**
 * xorshift32. Every bit of the state mixes on every step, so the low bits
 * that select a word are as well distributed as the high ones — a linear
 * congruential generator's are not (its low k bits cycle with period 2^k,
 * which would make every body a rotation of one short word cycle and every
 * fixture document a near-duplicate of every other).
 */
function seededBody(seed: number, wordCount: number): string {
  let state = seed >>> 0 || 1;
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    words.push(WORDS[state % WORDS.length]);
  }
  return words.join(" ");
}

/**
 * The body every clique member shares. Each member appends a distinct
 * one-word tail at the very end, so three of its 600 five-word shingles are
 * its own and 597 are shared with every sibling.
 *
 * That ratio is what carries the pair through the gate, and it is tighter
 * than it looks. Every shared shingle sits at df = CLIQUE_SIZE once the DF
 * table has seen the cluster, so `computeExclusivity` — which counts only
 * shingles at df <= 2 — reports `pairUniqueDf2 = 0` for every pair. The
 * file-like lane's OR-branch is therefore the only one open, and it needs
 * `containmentMin >= 0.95`: 597/600 = 0.995. A longer tail, a tail nearer
 * the middle, or a shorter body silently drops every pair in the cluster.
 */
const CLIQUE_BODY = seededBody(7, BODY_WORDS);

interface FixtureDoc {
  externalId: string;
  documentType: string;
  title: string;
  content: string;
  contentHash?: string;
}

const CLIQUE: FixtureDoc[] = VARIANT_TAILS.slice(0, CLIQUE_SIZE).map((tail, i) => ({
  externalId: `e2e-neardup-clique-${i}`,
  documentType: "file",
  title: `Quarterly field notes (revision ${i + 1})`,
  content: `${CLIQUE_BODY} variant ${tail} closing line`,
}));

/**
 * Unrelated file-like documents. Their only job is to keep the corpus large
 * enough that a shingle shared by the whole clique still carries weight: at
 * `total_docs = CLIQUE_SIZE` a shingle every clique member holds weighs
 * `log((N+1)/(N+1)) = 0` and drops out of the signature entirely, which
 * would collapse the cluster. `beforeAll` asserts the resulting corpus size
 * so that precondition is visible rather than assumed.
 */
const BALLAST: FixtureDoc[] = Array.from({ length: BALLAST_SIZE }, (_, i) => ({
  externalId: `e2e-neardup-ballast-${i}`,
  documentType: "file",
  title: `Unrelated working file ${i + 1}`,
  content: seededBody(1_000 + i, BALLAST_WORDS),
}));

/**
 * Shorter than `minContentLength`, so it is an arrival the DF trigger counts
 * and contributes no shingle to the table it triggers.
 */
const DF_REARM_CONTENT = "Too short to shingle.";

interface DfMeta {
  algoVersion: string;
  totalDocs: number;
  uniqueShingles: number;
  builtAt: number | null;
  liveGeneration: number;
}

describe("Near-duplicate batching and DF generations (e2e-minimal universe)", () => {
  let harness: SyntheticE2EHarness;
  /** External id -> gateway document id, for every fixture this file pushes. */
  const docIds = new Map<string, string>();
  /** Gateway document id -> external id, so a set diff names its documents. */
  const docLabels = new Map<string, string>();
  /**
   * How many of the six clique documents carried a signature after each
   * compute tick of the initial drain. The first test reads it as its
   * anti-vacuity guard: a cluster connected inside one batch proves nothing
   * about the persisted bucket path.
   */
  const cliqueSignedByTick: number[] = [];
  /** The algorithm version the code declares, read off the first boot. */
  let codeAlgoVersion = "";
  /** The metadata of the one DF build the whole corpus was first signed under. */
  let initialDf: DfMeta;

  // ── gateway helpers ────────────────────────────────────────────────

  interface SqlResponse<Row> {
    rows: Row[];
    rowCount: number;
    truncated?: boolean;
  }

  async function sql<Row extends unknown[]>(statement: string): Promise<Row[]> {
    const res = await harness.gatewayJson<SqlResponse<Row>>("/sql", {
      method: "POST",
      body: JSON.stringify({ sql: statement, limit: SQL_LIMIT }),
    });
    expect(res.truncated, `/sql clipped the result of: ${statement}`).toBeUndefined();
    return res.rows;
  }

  async function scalar(statement: string): Promise<number> {
    const rows = await sql<[number]>(statement);
    const value = Number(rows[0]?.[0]);
    expect(Number.isFinite(value), `not a number: ${statement}`).toBe(true);
    return value;
  }

  /** Run one allowlisted periodic to completion and return its result. */
  async function kick(taskName: string, timeoutMs = 120_000): Promise<{ idle?: boolean }> {
    const { result } = await harness.gatewayJson<{ result: { idle?: boolean } }>(
      `/admin/background/run/${encodeURIComponent(taskName)}?timeoutMs=${timeoutMs}`,
      { method: "POST", signal: AbortSignal.timeout(timeoutMs + 5_000) },
    );
    return result;
  }

  async function readDfMeta(): Promise<DfMeta> {
    const rows = await sql<[string, number, number, number | null, number]>(
      `SELECT algo_version, total_docs, unique_shingles, built_at, live_generation
         FROM near_dup_df_meta LIMIT 1`,
    );
    const row = rows[0];
    expect(row, "near_dup_df_meta holds no row").toBeDefined();
    return {
      algoVersion: row[0],
      totalDocs: Number(row[1]),
      uniqueShingles: Number(row[2]),
      builtAt: row[3] === null ? null : Number(row[3]),
      liveGeneration: Number(row[4]),
    };
  }

  async function inboxCount(): Promise<number> {
    return scalar("SELECT COUNT(*) FROM near_dup_inbox");
  }

  /**
   * How many documents a DF build over the current corpus would read — the
   * same filter `fetchDfDocChunk` applies. Used as the observable that a
   * published build covers everything this file has ingested.
   */
  async function eligibleDfDocCount(): Promise<number> {
    const types = ELIGIBLE_DOC_TYPES.map((t) => `'${t}'`).join(",");
    return scalar(
      `SELECT COUNT(*) FROM documents
        WHERE LENGTH(content) BETWEEN ${MIN_CONTENT_LENGTH} AND ${MAX_CONTENT_LENGTH}
          AND json_extract(metadata, '$.documentType') IN (${types})`,
    );
  }

  /** How many documents the boot algo-bump would enqueue. */
  async function eligibleDocCount(): Promise<number> {
    const types = ELIGIBLE_DOC_TYPES.map((t) => `'${t}'`).join(",");
    return scalar(
      `SELECT COUNT(*) FROM documents
        WHERE json_extract(metadata, '$.documentType') IN (${types})`,
    );
  }

  /**
   * Drive DF rebuilds until the published table covers at least
   * `minTotalDocs` documents.
   *
   * The condition is the published state, not the tick's return value: a
   * build that the gateway's own cadence started is as good as one this file
   * asked for, and waiting on `idle === false` would red when the two
   * coincide. When a build has landed but measured a smaller corpus, the
   * file-arrival trigger has already been consumed, so re-arming it takes a
   * new file-like document — one deliberately too short to contribute a
   * shingle to the table it triggers.
   */
  async function ensureDfCovers(minTotalDocs: number, timeoutMs = 180_000): Promise<DfMeta> {
    const deadline = Date.now() + timeoutMs;
    let rearms = 0;
    for (;;) {
      const meta = await readDfMeta();
      if (meta.builtAt !== null && meta.totalDocs >= minTotalDocs) return meta;
      if (Date.now() > deadline) {
        throw new Error(
          `DF table never covered ${minTotalDocs} documents (built_at=${meta.builtAt}, total_docs=${meta.totalDocs})`,
        );
      }
      if (meta.builtAt !== null) {
        await harness.pushDocuments([
          {
            externalId: `e2e-neardup-df-rearm-${rearms++}`,
            documentType: "file",
            title: "Rebuild trigger",
            content: DF_REARM_CONTENT,
          },
        ]);
      }
      await kick("backfill.nearDupDfRefresh");
    }
  }

  /** How many of `ids` currently have a `near_dup_inbox` row. */
  async function inboxRowsFor(ids: readonly string[]): Promise<number> {
    const list = ids.map((docId) => `'${docId}'`).join(",");
    return scalar(`SELECT COUNT(DISTINCT doc_id) FROM near_dup_inbox WHERE doc_id IN (${list})`);
  }

  /**
   * Push documents and return once the near-dup inbox holds a row for each of
   * them.
   *
   * `POST /documents` returns when the writer has committed the upsert; the
   * doc-upsert event reaches the inbox buffer after that, and the flush task
   * moves the buffer into the table. Gating on the rows rather than on a
   * flush reporting idle is what stops a compute drain from starting before
   * the documents it is meant to drain have been queued — an empty inbox and
   * a not-yet-observed one look identical from outside.
   */
  async function pushAndQueue(docs: readonly FixtureDoc[], timeoutMs = 120_000): Promise<void> {
    await harness.pushDocuments([...docs]);
    await resolveDocIds(docs.map((d) => d.externalId));
    const ids = docs.map((d) => id(d.externalId));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await flushInbox();
      const queued = await inboxRowsFor(ids);
      if (queued === ids.length) return;
      if (Date.now() > deadline) {
        throw new Error(`near-dup inbox holds ${queued} of ${ids.length} pushed documents`);
      }
    }
  }

  /** Drain the in-memory event buffer into `near_dup_inbox`. */
  async function flushInbox(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await kick("nearDup.inboxFlush");
      if (result.idle === true) return;
      if (Date.now() > deadline) {
        throw new Error("nearDup.inboxFlush never reached idle");
      }
    }
  }

  /**
   * Drive compute ticks until the inbox is empty, calling `afterTick` with
   * the remaining depth after each one. The loop's exit condition is the
   * inbox count — never elapsed time — so a slow box takes longer and
   * decides the same thing.
   */
  async function drainCompute(
    timeoutMs = 300_000,
    afterTick?: (remaining: number) => Promise<void> | void,
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let ticks = 0;
    let remaining = await inboxCount();
    while (remaining > 0) {
      if (Date.now() > deadline) {
        throw new Error(`near-dup compute left ${remaining} inbox rows before the deadline`);
      }
      await kick("backfill.nearDupCompute");
      ticks++;
      remaining = await inboxCount();
      await afterTick?.(remaining);
    }
    return ticks;
  }

  /** Gateway ids of the fixture documents named by `externalIds`. */
  async function resolveDocIds(externalIds: readonly string[]): Promise<void> {
    const list = externalIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    const rows = await sql<[string, string]>(
      `SELECT external_id, id FROM documents WHERE external_id IN (${list})`,
    );
    for (const [externalId, id] of rows) {
      docIds.set(externalId, id);
      docLabels.set(id, externalId);
    }
    for (const externalId of externalIds) {
      expect(docIds.has(externalId), `${externalId} never reached the gateway`).toBe(true);
    }
  }

  function id(externalId: string): string {
    const value = docIds.get(externalId);
    if (!value) throw new Error(`unresolved fixture document ${externalId}`);
    return value;
  }

  function label(docId: string): string {
    return docLabels.get(docId) ?? docId;
  }

  /** How many of the clique's six documents currently hold a signature. */
  async function cliqueSignatureCount(): Promise<number> {
    const list = CLIQUE.map((d) => `'${id(d.externalId)}'`).join(",");
    return scalar(`SELECT COUNT(*) FROM near_dup_signatures WHERE doc_id IN (${list})`);
  }

  /**
   * Every near-duplicate edge under the active algorithm, as canonical
   * `docA|docB` keys. The row count is cross-checked against a `COUNT(*)` so
   * a corpus that outgrew the row cap reds instead of silently comparing two
   * clipped sets.
   */
  async function edgeKeys(): Promise<string[]> {
    const where = `algo_version = (SELECT algo_version FROM near_dup_df_meta LIMIT 1)`;
    const expected = await scalar(`SELECT COUNT(*) FROM near_dup_edges WHERE ${where}`);
    const rows = await sql<[string, string]>(
      `SELECT doc_a, doc_b FROM near_dup_edges WHERE ${where} ORDER BY doc_a, doc_b`,
    );
    expect(rows.length, "the edge query returned fewer rows than the table holds").toBe(expected);
    return rows.map(([a, b]) => `${a}|${b}`);
  }

  function canonicalPair(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  function describeKeys(keys: readonly string[]): string {
    return keys
      .map((key) => {
        const [a, b] = key.split("|");
        return `${label(a)} ~ ${label(b)}`;
      })
      .sort()
      .join(", ");
  }

  /** The sixteen band buckets a document is indexed under. */
  async function bucketRows(docId: string): Promise<Array<[number, number]>> {
    const rows = await sql<[number, number]>(
      `SELECT band_idx, bucket_hash FROM near_dup_lsh_buckets
        WHERE doc_id = '${docId}'
          AND algo_version = (SELECT algo_version FROM near_dup_df_meta LIMIT 1)
        ORDER BY band_idx`,
    );
    return rows.map(([band, hash]) => [Number(band), Number(hash)]);
  }

  // ── setup ──────────────────────────────────────────────────────────

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic",
      universe: "e2e-minimal",
      // Every harness request carries the admin key and no device id, so the
      // gateway classifies all of them as user priority and holds an
      // admission pause for their duration. That pause taxes each hand-driven
      // periodic tick by the hold backstop and pushes every yielded
      // continuation onto the anti-starvation floor — minutes of dead time
      // across a file that drives a hundred ticks, and none of it is what any
      // test here is about.
      extraGatewayEnv: { OMNESIS_ADMISSION_ENABLED: "0" },
      extraGatewayConfig: {
        nearDuplicates: {
          minContentLength: MIN_CONTENT_LENGTH,
          scheduler: {
            computePeriodMs: PARKED_PERIOD_MS,
            computeIdlePeriodMs: PARKED_PERIOD_MS,
            computeBatchSize: COMPUTE_BATCH_SIZE,
            // No floor under the file-arrival trigger, so a rebuild is
            // available the moment this file pushes a file-like document and
            // unavailable at every other moment.
            dfRefreshPeriodMs: 1,
          },
        },
      },
    });
    await harness.start();
    await harness.syncAllSources();
    const drained = await harness.stopSyncLoopsAndDrain(90_000);
    expect(drained.timedOut, `collector did not drain (${drained.inflight} in flight)`).toBe(false);

    await pushAndQueue([...BALLAST, ...CLIQUE]);

    // One DF build over the whole frozen corpus. Everything this file signs —
    // here and after the re-sign in the second test — is signed against a
    // table built from these same documents, which is what makes the two
    // graphs comparable.
    const meta = await ensureDfCovers(await eligibleDfDocCount());
    initialDf = meta;
    codeAlgoVersion = meta.algoVersion;
    expect(meta.builtAt).not.toBeNull();
    expect(meta.uniqueShingles).toBeGreaterThan(0);
    expect(
      meta.totalDocs,
      `the corpus is too small for a shared shingle to carry weight (total_docs=${meta.totalDocs})`,
    ).toBeGreaterThanOrEqual(12);

    await drainCompute(300_000, async () => {
      cliqueSignedByTick.push(await cliqueSignatureCount());
    });
  }, 600_000);

  afterAll(async () => {
    await harness.destroy();
  }, 30_000);

  test("a near-duplicate cluster drained across several compute batches ends up fully connected", async () => {
    // Anti-vacuity first. If the batch size were ignored, all six documents
    // would be signed in one tick and the in-batch band index alone would
    // produce all fifteen pairs — the test would pass green over none of the
    // persisted-bucket path it exists for. A tick can add at most
    // COMPUTE_BATCH_SIZE signatures, so a cluster of six spread over three
    // or more ticks is a cluster the in-memory index could not have
    // connected on its own.
    let previous = 0;
    let ticksThatSigned = 0;
    for (const count of cliqueSignedByTick) {
      if (count > previous) {
        expect(
          count - previous,
          `one compute tick signed ${count - previous} clique documents; batch size is ${COMPUTE_BATCH_SIZE}`,
        ).toBeLessThanOrEqual(COMPUTE_BATCH_SIZE);
        ticksThatSigned++;
      }
      previous = count;
    }
    expect(previous, "not every clique document was signed").toBe(CLIQUE_SIZE);
    expect(
      ticksThatSigned,
      `the cluster was drained in ${ticksThatSigned} tick(s): ${cliqueSignedByTick.join(",")}`,
    ).toBeGreaterThanOrEqual(3);

    // The invariant. Every pair in the cluster is 99% contained in its twin
    // by the gate's own measure, so a missing pair is a document the operator
    // would see listed on one of its twins and not on another.
    const present = new Set(await edgeKeys());
    const missing: string[] = [];
    for (let a = 0; a < CLIQUE_SIZE; a++) {
      for (let b = a + 1; b < CLIQUE_SIZE; b++) {
        const key = canonicalPair(id(CLIQUE[a].externalId), id(CLIQUE[b].externalId));
        if (!present.has(key)) missing.push(key);
      }
    }
    expect(missing, `clique pairs never recorded: ${describeKeys(missing)}`).toEqual([]);

    // The surface the portal's similar-documents panel and the agent's
    // neighbour list actually read.
    const { edges } = await harness.gatewayJson<{ edges: Array<{ otherDocId: string }> }>(
      `/documents/${id(CLIQUE[0].externalId)}/near-dupes`,
    );
    const neighbours = new Set(edges.map((e) => e.otherDocId));
    for (const sibling of CLIQUE.slice(1)) {
      expect(
        neighbours.has(id(sibling.externalId)),
        `${sibling.externalId} is not listed as a near-duplicate of ${CLIQUE[0].externalId}`,
      ).toBe(true);
    }
  }, 120_000);

  test("re-signing the whole corpus reproduces the near-duplicate graph it already had", async () => {
    const groundTruth = await edgeKeys();
    // Without this the comparison below could equate two empty sets — a bump
    // that enqueued nothing looks identical to a redrain that lost nothing.
    expect(
      groundTruth.length,
      "the corpus holds fewer edges than the clique alone contributes",
    ).toBeGreaterThanOrEqual((CLIQUE_SIZE * (CLIQUE_SIZE - 1)) / 2);
    const eligible = await eligibleDocCount();

    // Stage exactly the state a real algorithm change leaves behind once the
    // sweep has retired the old rows: an empty candidate index and a meta row
    // naming a version the code no longer declares. The gateway is fully
    // stopped while it is written, so no second writer exists.
    await harness.restartGateway(() => {
      const db = new SqliteDatabase(harness.getDbPath());
      try {
        db.transaction(() => {
          db.prepare("UPDATE near_dup_df_meta SET algo_version = ?").run(PRIOR_ALGO_VERSION);
          db.prepare("DELETE FROM near_dup_signatures").run();
          db.prepare("DELETE FROM near_dup_lsh_buckets").run();
          db.prepare("DELETE FROM near_dup_edges").run();
          db.prepare("DELETE FROM near_dup_df").run();
        }).immediate();
      } finally {
        db.close();
      }
    });

    // The boot bump runs after the port is listening, so `/health` answering
    // does not mean it has landed. Wait for what it writes.
    await waitForCondition(
      async () => (await readDfMeta()).algoVersion === codeAlgoVersion,
      60_000,
      "the boot algo-bump to adopt the code-declared algorithm version",
    );
    const bumped = await readDfMeta();
    expect(bumped.builtAt, "the bump left a DF table the compute drip would use").toBeNull();
    await waitForCondition(
      async () => (await inboxCount()) >= eligible,
      60_000,
      `the boot algo-bump to enqueue all ${eligible} eligible documents`,
    );

    await flushInbox();
    const rebuilt = await ensureDfCovers(await eligibleDfDocCount());
    // The corpus did not change, so the rebuild has to measure the same thing
    // the first build did. A DF table is a pure function of the corpus, and
    // both of its inputs to a signature — the per-shingle counts and
    // `total_docs` — have to match, or the two drains were signed against
    // different statistics and the comparison below would be measuring the
    // weighting rather than the batching.
    expect(
      { totalDocs: rebuilt.totalDocs, uniqueShingles: rebuilt.uniqueShingles },
      "the re-sign's DF build measured a different corpus than the first one",
    ).toEqual({ totalDocs: initialDf.totalDocs, uniqueShingles: initialDf.uniqueShingles });
    await drainCompute();
    expect(await inboxCount()).toBe(0);

    const after = await edgeKeys();
    const beforeSet = new Set(groundTruth);
    const afterSet = new Set(after);
    const lost = groundTruth.filter((key) => !afterSet.has(key));
    const gained = after.filter((key) => !beforeSet.has(key));
    // Set equality is the invariant because the corpus did not change: the
    // same documents, scanned by the same build and signed by the same
    // sketcher, must yield the same graph. A loss means the redrain dropped
    // edges; a gain means the first drain missed them. Both are the same
    // defect seen from opposite ends, and both are what the operator
    // experiences as a graph that changes under them for no reason.
    expect(
      { lost: describeKeys(lost), gained: describeKeys(gained) },
      "the whole-corpus re-sign did not reproduce the graph",
    ).toEqual({ lost: "", gained: "" });
  }, 420_000);

  /**
   * Skipped: it fails, and it fails because the product is wrong.
   *
   * A document's sixteen band hashes are a function of the DF table it was
   * signed against — `IdfSketcher.weightOf` feeds `idfWeight(df, totalDocs)`
   * into the weighted MinHash (`packages/near-dupes/src/algo/sketcher.ts:102`)
   * — but `near_dup_lsh_buckets` is keyed by algorithm version alone and
   * records nothing about which build produced the row
   * (`packages/gateway/src/data/schema.ts:863`). Nothing re-signs a document
   * when the table is rebuilt: `nearDupDfRefreshTask` publishes the new
   * generation, drops the cached table and returns
   * (`packages/gateway/src/scheduler/tasks/backfill-tasks.ts:1394`), and the
   * one helper that would carry a re-sign watermark,
   * `applySweepWatermark` (`packages/gateway/src/near-dupes/NearDupWriterOps.ts`),
   * has no caller anywhere in the repo even though `sweepPeriodMs` and
   * `sweepChunkSize` are configurable. Since `fetchNearDupCandidates`
   * (`packages/gateway/src/near-dupes/NearDupComputeService.ts:474`) reads
   * only that table, a document signed before a rebuild and one signed after
   * are never offered to each other, whatever the gate would have said.
   *
   * Observed on a real gateway: two documents whose `content` strings are
   * identical, signed under generation 1 (total_docs 30) and generation 2
   * (total_docs 121), agreed on 2 of their 16 bands. The control in the same
   * test — two byte-identical documents signed under ONE table in two
   * different compute ticks — is linked, so the gate and the persisted-bucket
   * path both work; only the generation drift is missing.
   *
   * Fixing it is a product decision, not a restoration. The correct fix folds
   * the DF generation into the bucket key and re-signs on every rebuild, and
   * the re-sign is the whole corpus; the alternatives are re-signing lazily
   * on read, or rebuilding the table far less often and accepting the drift.
   * The assertion below states the promise; the operator picks the price.
   */
  test.skip("byte-identical documents are near-duplicates of each other whichever DF build signed them", async () => {
    const subject: FixtureDoc = {
      externalId: "e2e-neardup-subject-early",
      documentType: "file",
      title: "Field notes, first copy",
      content: seededBody(101, BODY_WORDS),
      contentHash: "sha256:e2e-neardup-subject-early",
    };
    await pushAndQueue([subject]);
    await drainCompute();
    const early = await readDfMeta();
    const earlyBuckets = await bucketRows(id(subject.externalId));
    expect(earlyBuckets.length, "the subject was not indexed at all").toBe(16);

    // Grow the corpus threefold and rebuild. Nothing re-signs a document
    // after a rebuild, so the subject keeps the buckets it was written with.
    const fillers: FixtureDoc[] = Array.from(
      { length: Math.max(80, 3 * early.totalDocs) },
      (_, i) => ({
        externalId: `e2e-neardup-filler-${i}`,
        documentType: "file",
        title: `Working file ${i + 1}`,
        content: seededBody(50_000 + i, BALLAST_WORDS),
      }),
    );
    await pushAndQueue(fillers);
    const grown = await ensureDfCovers(early.totalDocs + fillers.length);
    // Preconditions: the rebuild really happened, and it really moved the
    // weighting the signatures are a function of.
    expect(grown.liveGeneration).toBeGreaterThan(early.liveGeneration);
    expect(
      grown.totalDocs,
      `the corpus grew from ${early.totalDocs} to ${grown.totalDocs}`,
    ).toBeGreaterThanOrEqual(3 * early.totalDocs);
    await drainCompute();

    // Two more copies of the subject's bytes, each with its own content hash
    // so the exact-duplicate filter does not suppress the pair, plus a
    // divider so the two are drained in different compute ticks. That makes
    // the control travel the same path as the subject: `near_dup_lsh_buckets`
    // is the only way a document can be offered a candidate from an earlier
    // tick.
    const late: FixtureDoc[] = [
      {
        externalId: "e2e-neardup-subject-late-a",
        documentType: "file",
        title: "Field notes, second copy",
        content: subject.content,
        contentHash: "sha256:e2e-neardup-subject-late-a",
      },
      {
        externalId: "e2e-neardup-divider",
        documentType: "file",
        title: "Unrelated working file",
        content: seededBody(90_001, BALLAST_WORDS),
      },
      {
        externalId: "e2e-neardup-subject-late-b",
        documentType: "file",
        title: "Field notes, third copy",
        content: subject.content,
        contentHash: "sha256:e2e-neardup-subject-late-b",
      },
    ];
    await pushAndQueue(late);
    const beforeLate = await readDfMeta();
    await drainCompute();
    const afterLate = await readDfMeta();
    // The control is only a control if both copies were signed against one
    // table. A rebuild between the two ticks would make it a second instance
    // of the subject rather than a baseline.
    expect(afterLate.liveGeneration, "the DF table moved mid-control").toBe(
      beforeLate.liveGeneration,
    );

    const lateA = id("e2e-neardup-subject-late-a");
    const lateB = id("e2e-neardup-subject-late-b");
    const edges = new Set(await edgeKeys());
    expect(
      edges.has(canonicalPair(lateA, lateB)),
      "two identical documents signed under one DF table in different ticks were not linked",
    ).toBe(true);

    // The subject. `near_dup_lsh_buckets` IS the candidate index — the only
    // table `fetchNearDupCandidates` reads — so two documents holding the
    // same bytes but landing in disjoint buckets can never be offered to
    // each other, whatever the gate would have said about them.
    //
    // The edge itself is deliberately not the assertion. A single surviving
    // band is enough for the two to be offered to each other, and identical
    // content then sails through the gate, so the pair can be recorded even
    // when fifteen of the sixteen bands have diverged — the product-level
    // question is green over most corpus shapes while the defect is fully
    // present. The bucket rows are where the promise becomes decidable.
    const lateBuckets = await bucketRows(lateA);
    const lateByBand = new Map(lateBuckets.map(([band, hash]) => [band, hash]));
    const agreeing = earlyBuckets.filter(([band, hash]) => lateByBand.get(band) === hash).length;
    expect(
      lateBuckets,
      `identical content indexed under ${agreeing}/16 matching bands: generation ${early.liveGeneration} (total_docs ${early.totalDocs}) vs generation ${afterLate.liveGeneration} (total_docs ${afterLate.totalDocs})`,
    ).toEqual(earlyBuckets);
  }, 600_000);
});
