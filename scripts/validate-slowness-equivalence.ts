// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reference-implementation equivalence for the gateway's cost-sensitive
 * algorithms, run against a real corpus rather than an invented one.
 *
 * Each algorithm below is expressed twice: once as the naive formulation
 * that is obviously correct and much too slow to run in production, and
 * once as the query the gateway actually uses. They must agree row for row.
 * Unit fixtures already prove that on tens of documents; the shapes that
 * only appear at scale — a person merged into another with thousands of
 * edges, a document whose content pages awkwardly, a shingle distribution
 * with a long tail — do not appear in fixtures at all, so this runs both
 * over the same corpus at the same instant and diffs the output.
 *
 * Point it at any gateway database (`OMNESIS_DB_PATH`, or
 * `OMNESIS_CONFIG_DIR`) before changing one of these queries, and again
 * after. Strictly read-only: the corpus is opened with a read-only handle
 * and every write this needs goes to a scratch database of its own.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { openReadOnlyDatabase } from "../packages/gateway/src/db.js";
import { resolveGatewayStorageEncryptionKeys } from "../packages/gateway/src/storage-encryption.js";
import { peopleCountsChunkSql } from "../packages/gateway/src/data/repositories/PersonRepository.js";
import { interactionScoresChunkSql } from "../packages/gateway/src/domain/InteractionScoreService.js";
import {
  DIRECT_RESOLVABLE_SCAN_SQL,
  resolveLink,
} from "../packages/gateway/src/domain/LinkGraphService.js";
import { resolveExtractedLinks } from "../packages/gateway/src/domain/LinkExtraction.js";
import { getUrlCanonicalizerSpecs } from "../packages/gateway/src/url-canonicalizers.js";
import { extractLinksFromDocs } from "../packages/gateway/src/domain/LinkExtraction-cpu.js";
import { ShingleDfAccumulator } from "../packages/gateway/src/near-dupes/NearDupDfService.js";
import { extractDfChunk } from "../packages/gateway/src/near-dupes/NearDupDfCpu.js";
import type { Db } from "../packages/gateway/src/data/types.js";

const CONFIG_DIR =
  process.env.OMNESIS_CONFIG_DIR ?? join(process.env.HOME ?? "", ".config/omnesis");
const DB_PATH = process.env.OMNESIS_DB_PATH ?? join(CONFIG_DIR, "omnesis.db");
/** How many real documents the DF comparison uses. */
const DF_SAMPLE = Number(process.env.VALIDATE_DF_SAMPLE ?? 20_000);

let failures = 0;
function report(name: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}

// ── reference formulations: obviously correct, too slow to ship ──────────

const REFERENCE_PEOPLE_COUNTS_SQL = `WITH batch AS (
    SELECT id FROM people WHERE merged_into IS NULL AND id > ? ORDER BY id LIMIT ?
  )
  SELECT b.id AS person_id,
    COALESCE(d.cnt, 0) AS doc_count,
    COALESCE(a.cnt, 0) AS alias_count
  FROM batch b
  LEFT JOIN (
    SELECT COALESCE(p2.merged_into, p2.id) AS canonical, COUNT(DISTINCT dp.document_id) AS cnt
    FROM document_people dp JOIN people p2 ON p2.id = dp.person_id
    WHERE COALESCE(p2.merged_into, p2.id) IN (SELECT id FROM batch)
    GROUP BY canonical
  ) d ON d.canonical = b.id
  LEFT JOIN (
    SELECT COALESCE(p2.merged_into, p2.id) AS canonical, COUNT(*) AS cnt
    FROM person_aliases pa JOIN people p2 ON p2.id = pa.person_id
    WHERE COALESCE(p2.merged_into, p2.id) IN (SELECT id FROM batch)
    GROUP BY canonical
  ) a ON a.canonical = b.id`;

const REFERENCE_INTERACTION_CHUNK_SQL = `WITH batch_people AS (
    SELECT id FROM people
    WHERE merged_into IS NULL
      AND (is_self IS NULL OR is_self = FALSE)
      AND id > ?
    ORDER BY id LIMIT ?
  ),
  self_role AS (
    SELECT dp.document_id,
      MAX(CASE
        WHEN dp.role IN ('author','sender','owner') THEN 2
        WHEN dp.role IN ('recipient','attendee','participant') THEN 1
        ELSE 0 END) AS k
    FROM document_people dp
    JOIN people p ON p.id = dp.person_id
    WHERE COALESCE(p.merged_into, p.id) = ?
    GROUP BY dp.document_id
    HAVING k > 0
  ),
  person_role AS (
    SELECT dp.document_id,
      COALESCE(p.merged_into, p.id) AS canonical_person_id,
      MAX(CASE
        WHEN dp.role IN ('author','sender','owner') THEN 2
        WHEN dp.role IN ('recipient','attendee','participant') THEN 1
        ELSE 0 END) AS k
    FROM document_people dp
    JOIN people p ON p.id = dp.person_id
    WHERE COALESCE(p.merged_into, p.id) IN (SELECT id FROM batch_people)
    GROUP BY dp.document_id, canonical_person_id
    HAVING k > 0
  )
  SELECT pr.canonical_person_id AS person_id,
    sr.k AS self_k, pr.k AS p_k,
    d.source_created_at AS doc_date
  FROM self_role sr
  JOIN person_role pr ON pr.document_id = sr.document_id
  JOIN documents d ON d.id = sr.document_id`;

const REFERENCE_DIRECT_SCAN_SQL = `SELECT dl.id AS link_id, d.id AS target_id
         FROM documents d
         CROSS JOIN document_links dl INDEXED BY idx_document_links_unresolved
           ON dl.normalized_target = d.source_url
        WHERE d.source_url IS NOT NULL
          AND dl.link_type = 'url'
          AND dl.target_doc_id IS NULL
        LIMIT ?`;

// ── comparisons ──────────────────────────────────────────────────────────

function comparePeopleCounts(db: Db): void {
  const batch = 1_000;
  let cursor = "";
  let batches = 0;
  let rows = 0;
  let mismatches = 0;
  const started = Date.now();
  let referenceMs = 0;
  let gatewayMs = 0;
  for (;;) {
    let t = Date.now();
    const oldRows = db
      .prepare<
        [string, number],
        { person_id: string; doc_count: number; alias_count: number }
      >(REFERENCE_PEOPLE_COUNTS_SQL)
      .all(cursor, batch);
    referenceMs += Date.now() - t;
    t = Date.now();
    const newRows = db
      .prepare<
        [string, number],
        { person_id: string; doc_count: number; alias_count: number }
      >(peopleCountsChunkSql())
      .all(cursor, batch);
    gatewayMs += Date.now() - t;

    if (oldRows.length !== newRows.length) mismatches += 1;
    for (let i = 0; i < Math.min(oldRows.length, newRows.length); i++) {
      const a = oldRows[i];
      const b = newRows[i];
      if (
        a.person_id !== b.person_id ||
        a.doc_count !== b.doc_count ||
        a.alias_count !== b.alias_count
      ) {
        if (mismatches < 5) {
          console.log(`      first mismatch: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
        }
        mismatches += 1;
      }
    }
    rows += newRows.length;
    batches += 1;
    if (newRows.length < batch) break;
    cursor = newRows[newRows.length - 1].person_id;
  }
  report(
    "C4 people counts",
    mismatches === 0,
    `${rows} people over ${batches} chunks, ${mismatches} mismatches — reference ${referenceMs}ms, gateway ${gatewayMs}ms (${(referenceMs / Math.max(gatewayMs, 1)).toFixed(1)}x), wall ${Date.now() - started}ms`,
  );
}

function compareInteractionScores(db: Db): void {
  const self = db
    .prepare<
      [],
      { id: string }
    >("SELECT id FROM people WHERE is_self = TRUE AND merged_into IS NULL LIMIT 1")
    .get();
  if (!self) {
    report("C5 interaction scores", true, "no self person on this corpus — nothing to compare");
    return;
  }
  const batch = 500;
  let cursor = "";
  let chunks = 0;
  let tuples = 0;
  let mismatches = 0;
  let referenceMs = 0;
  let gatewayMs = 0;
  const key = (r: { person_id: string; self_k: number; p_k: number; doc_date: string | null }) =>
    `${r.person_id}|${r.self_k}|${r.p_k}|${r.doc_date ?? ""}`;
  for (;;) {
    let t = Date.now();
    const oldRows = db
      .prepare<
        [string, number, string],
        { person_id: string; self_k: number; p_k: number; doc_date: string | null }
      >(REFERENCE_INTERACTION_CHUNK_SQL)
      .all(cursor, batch, self.id);
    referenceMs += Date.now() - t;
    t = Date.now();
    const newRows = db
      .prepare<
        [string, number, string, string],
        { person_id: string; self_k: number; p_k: number; doc_date: string | null }
      >(interactionScoresChunkSql())
      .all(cursor, batch, self.id, self.id);
    gatewayMs += Date.now() - t;

    const referenceKeys = oldRows.map(key).sort();
    const newKeys = newRows.map(key).sort();
    if (referenceKeys.length !== newKeys.length || referenceKeys.some((k, i) => k !== newKeys[i])) {
      if (mismatches === 0) {
        const onlyReference = referenceKeys.filter((k) => !newKeys.includes(k)).slice(0, 3);
        const onlyNew = newKeys.filter((k) => !referenceKeys.includes(k)).slice(0, 3);
        console.log(
          `      only-reference: ${JSON.stringify(onlyReference)}  only-new: ${JSON.stringify(onlyNew)}`,
        );
      }
      mismatches += 1;
    }
    tuples += newRows.length;
    chunks += 1;
    // Cursor advances over the people batch, mirroring the production sweep.
    const lastBatch = db
      .prepare<[string, number], { id: string }>(
        `SELECT id FROM people WHERE merged_into IS NULL AND (is_self IS NULL OR is_self = FALSE)
           AND id > ? ORDER BY id LIMIT ?`,
      )
      .all(cursor, batch);
    if (lastBatch.length < batch) break;
    cursor = lastBatch[lastBatch.length - 1].id;
  }
  report(
    "C5 interaction scores",
    mismatches === 0,
    `${tuples} edge tuples over ${chunks} chunks, ${mismatches} differing chunks — reference ${referenceMs}ms, gateway ${gatewayMs}ms (${(referenceMs / Math.max(gatewayMs, 1)).toFixed(1)}x)`,
  );
}

function compareDirectScan(db: Db): void {
  let t = Date.now();
  const newRows = db
    .prepare<[number, number], { link_id: number; target_id: string }>(DIRECT_RESOLVABLE_SCAN_SQL)
    .all(20_000, 50);
  const gatewayMs = Date.now() - t;
  t = Date.now();
  const oldRows = db
    .prepare<[number], { link_id: number; target_id: string }>(REFERENCE_DIRECT_SCAN_SQL)
    .all(50);
  const referenceMs = Date.now() - t;
  const same =
    newRows.length === oldRows.length &&
    new Set(newRows.map((r) => `${r.link_id}|${r.target_id}`)).size ===
      new Set([...newRows, ...oldRows].map((r) => `${r.link_id}|${r.target_id}`)).size;
  report(
    "C2 link reconcile direct scan",
    same,
    `${newRows.length} resolvable links found by both — reference ${referenceMs}ms, gateway ${gatewayMs}ms (${(referenceMs / Math.max(gatewayMs, 1)).toFixed(1)}x)`,
  );
}

/**
 * Link resolution: the writer's per-link lookup against the read phase's.
 *
 * The gateway resolves a link on a read handle before the writer ever sees
 * it. The reference here is the same decision made the way a writer would
 * make it — `resolveLink` per link, one at a time, in document order — and
 * the two must name the same target for every link of every type.
 *
 * Documents are sampled from the real corpus and re-extracted read-only;
 * nothing is written. Both sides read the corpus as it stands, including
 * its `document_links` rows — `shares-phone` resolves against those by
 * definition — so this compares two resolvers over one fixed state, not a
 * resolver against a corpus built from nothing.
 *
 * What it can and cannot see: both sides call `resolveLink` with the same
 * arguments, so it proves the batch pass finds what a per-link pass finds
 * and does not lose the extra `shares-phone` pairs it is meant to add. It
 * would not catch a regression in the arguments themselves, since it would
 * pass the same wrong ones to both.
 */
function compareLinkResolution(db: Db, sampleDocs: number): void {
  const rows = db
    .prepare<
      [number],
      {
        id: string;
        source_id: string;
        external_id: string;
        content: string;
        content_hash: string;
        metadata: string;
      }
    >(
      `SELECT id, source_id, external_id, content, content_hash, metadata
         FROM documents
        WHERE content IS NOT NULL AND content != ''
        ORDER BY id
        LIMIT ?`,
    )
    .all(sampleDocs);

  // The cpu phase, called exactly as the gateway calls it: one document per
  // invocation, no database in reach, and the canonicalizer specs passed
  // through — without them a url normalizes differently here than it does
  // in the gateway, and the sample would not be the links production
  // resolves.
  const canonicalizers = getUrlCanonicalizerSpecs();
  const extracted = rows.flatMap((row) => extractLinksFromDocs([row], canonicalizers));
  const totalLinks = extracted.reduce((n, e) => n + e.links.length, 0);

  let t = Date.now();
  const reference = new Map<string, string>();
  for (const entry of extracted) {
    for (const link of entry.links) {
      const target = resolveLink(db, link, entry.sourceId, entry.docId);
      if (target) {
        reference.set(
          `${entry.docId}\u0000${link.type}\u0000${link.normalizedTarget}`,
          target.docId,
        );
      }
    }
  }
  const referenceMs = Date.now() - t;

  t = Date.now();
  const resolved = resolveExtractedLinks(db, extracted, []);
  const gatewayMs = Date.now() - t;

  const gateway = new Map<string, string>();
  for (const entry of resolved) {
    for (const [key, docId] of Object.entries(entry.resolvedTargets ?? {})) {
      const [type, target] = key.split("\u0000");
      gateway.set(`${entry.docId}\u0000${type}\u0000${target}`, docId);
    }
  }

  // `shares-phone` is directional and resolves against sibling links, so the
  // batch-wide pass legitimately finds pairs the one-at-a-time reference
  // cannot. Those are reported separately rather than counted as drift.
  let mismatches = 0;
  let batchOnly = 0;
  const examples: string[] = [];
  for (const [key, docId] of gateway) {
    const ref = reference.get(key);
    if (ref === docId) continue;
    if (ref === undefined && key.includes("\u0000shares-phone\u0000")) {
      batchOnly += 1;
      continue;
    }
    mismatches += 1;
    if (examples.length < 3) examples.push(key.split("\u0000")[1]);
  }
  for (const key of reference.keys()) {
    if (!gateway.has(key)) {
      mismatches += 1;
      if (examples.length < 3) examples.push(`${key.split("\u0000")[1]} (reference only)`);
    }
  }

  report(
    "C1 link resolution",
    mismatches === 0,
    `${rows.length} documents, ${totalLinks} links, ${gateway.size} resolved, ${mismatches} mismatches` +
      `${batchOnly > 0 ? `, ${batchOnly} shares-phone pair(s) only the batch pass finds` : ""}` +
      ` — reference ${referenceMs}ms, gateway ${gatewayMs}ms` +
      `${examples.length > 0 ? ` [${examples.join(", ")}]` : ""}`,
  );
}

/**
 * DF pipelines, one per process.
 *
 * Peak RSS is the number this rewrite exists to move, and it cannot be
 * measured for two pipelines in one process: the first leaves its heap
 * behind, so the second's "peak" includes it. Each mode below runs one
 * pipeline alone and writes its table to `VALIDATE_DF_OUT`; `compare` then
 * reads the two tables back and checks them against each other.
 */
function runDfPipeline(db: Db, mode: "reference" | "gateway", outPath: string): void {
  const eligible = ["email", "attachment", "file", "document", "note", "conversation"];
  const placeholders = eligible.map(() => "?").join(",");
  const docs = db
    .prepare<unknown[], { id: string; content: string }>(
      `SELECT id, content FROM documents
        WHERE LENGTH(content) BETWEEN ? AND ?
          AND json_extract(metadata, '$.documentType') IN (${placeholders})
        ORDER BY id LIMIT ?`,
    )
    .all(200, 2_000_000, ...eligible, DF_SAMPLE);

  let peak = process.memoryUsage.rss();
  const timer = setInterval(() => {
    const rss = process.memoryUsage.rss();
    if (rss > peak) peak = rss;
  }, 50);
  timer.unref();
  const started = Date.now();
  let rows: Array<{ shingle: string; df: number }>;

  const pageSize = 500;
  const accumulate = (accum: ShingleDfAccumulator): void => {
    // Identical extraction in both modes, so the only difference measured
    // is where the counts accumulate and how they reach the writer.
    for (let offset = 0; offset < docs.length; offset += pageSize) {
      const merged: Array<[string, number]> = [];
      for (const row of docs.slice(offset, offset + pageSize)) {
        const result = extractDfChunk({
          contents: [row.content],
          shingleSize: 5,
          stripQuotes: true,
        });
        for (const pair of result.shingleCounts) merged.push(pair);
      }
      accum.add(merged);
    }
  };

  if (mode === "reference") {
    // Accumulated in process memory, then every surviving row materialised
    // as a JavaScript object and handed across the thread boundary — the
    // shape being replaced. Both of those are counted here because both
    // happened in production.
    const accum = new ShingleDfAccumulator();
    accumulate(accum);
    rows = accum.entries(2);
    peak = Math.max(peak, process.memoryUsage.rss());
    clearInterval(timer);
    accum.close();
  } else {
    // Paged, accumulated into a file, never materialised in this process.
    const stagingPath = `${outPath}.staging`;
    rmSync(stagingPath, { force: true });
    // Scratch output of a read-only comparison, not a store: no key.
    const accum = new ShingleDfAccumulator(stagingPath, null);
    accumulate(accum);
    accum.checkpoint();
    peak = Math.max(peak, process.memoryUsage.rss());
    accum.close({ deleteFile: false });
    // Production stops here: the writer attaches the staging file. Stop
    // sampling too, so the read-back below — which exists only to write a
    // file this script can compare — is not charged to the pipeline.
    clearInterval(timer);
    const staged = new Database(stagingPath, { readonly: true });
    rows = staged
      .prepare<
        [number],
        { shingle: string; df: number }
      >("SELECT shingle, df FROM df WHERE df >= ?")
      .all(2);
    staged.close();
    rmSync(stagingPath, { force: true });
  }
  const tookMs = Date.now() - started;

  rmSync(outPath, { force: true });
  const out = new Database(outPath);
  out.pragma("journal_mode = OFF");
  out.pragma("synchronous = OFF");
  out.exec("CREATE TABLE df (shingle TEXT PRIMARY KEY, df INTEGER NOT NULL) WITHOUT ROWID");
  const insert = out.prepare("INSERT OR REPLACE INTO df (shingle, df) VALUES (?, ?)");
  const tx = out.transaction((batch: Array<{ shingle: string; df: number }>) => {
    for (const r of batch) insert.run(r.shingle, r.df);
  });
  tx(rows);
  out.close();

  console.log(
    `${mode}: ${docs.length} documents → ${rows.length} shingles above the prune, ` +
      `${tookMs}ms, peak RSS ${(peak / 1024 ** 3).toFixed(2)}GiB`,
  );
}

function compareDfOutputs(oldPath: string, newPath: string): void {
  const a = new Database(oldPath, { readonly: true });
  const b = new Database(newPath, { readonly: true });
  try {
    const counts = (h: Database.Database) =>
      h.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM df").get()?.n ?? 0;
    a.prepare("SELECT 1").get();
    b.exec(`ATTACH DATABASE '${oldPath}' AS old_df`);
    const differing =
      b
        .prepare<[], { n: number }>(
          `SELECT COUNT(*) AS n FROM (
             SELECT shingle, df FROM df
             EXCEPT
             SELECT shingle, df FROM old_df.df
           )`,
        )
        .get()?.n ?? 0;
    const missing =
      b
        .prepare<[], { n: number }>(
          `SELECT COUNT(*) AS n FROM (
             SELECT shingle, df FROM old_df.df
             EXCEPT
             SELECT shingle, df FROM df
           )`,
        )
        .get()?.n ?? 0;
    b.exec("DETACH DATABASE old_df");
    report(
      "C6 near-duplicate DF table",
      differing === 0 && missing === 0,
      `${counts(a)} rows (reference) vs ${counts(b)} rows (gateway); ${differing} only-in-new, ${missing} only-in-reference`,
    );
  } finally {
    a.close();
    b.close();
  }
}

async function main(): Promise<void> {
  const keys = await resolveGatewayStorageEncryptionKeys(CONFIG_DIR);
  const db = openReadOnlyDatabase(DB_PATH, {
    ...(keys.mainDbKey ? { encryptionKey: keys.mainDbKey } : {}),
    cacheSizeBytes: 64 * 1024 * 1024,
  });
  try {
    const docs = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM documents").get();
    console.log(`corpus: ${docs?.n ?? 0} documents (read-only)\n`);
    // Every knob is an environment variable. An argument on the command
    // line is therefore always a mistake, and a silent one — the run would
    // do something other than what was asked for and still report success.
    const argv = process.argv.slice(2);
    if (argv.length > 0) {
      console.error(
        `unexpected argument ${JSON.stringify(argv[0])}. This script is configured by environment variables:\n` +
          `  VALIDATE_ONLY=people|scores|links|resolve   run one comparison (default: all)\n` +
          `  VALIDATE_DF_PIPELINE=reference|gateway|compare   run the DF pipeline instead\n` +
          `  VALIDATE_LINK_DOCS=<n>   documents sampled by the link comparison\n` +
          `  OMNESIS_DB_PATH / OMNESIS_CONFIG_DIR   which corpus to read`,
      );
      process.exit(2);
    }
    const only = process.env.VALIDATE_ONLY;
    const dfMode = process.env.VALIDATE_DF_PIPELINE;
    if (dfMode === "reference" || dfMode === "gateway") {
      runDfPipeline(
        db,
        dfMode,
        process.env.VALIDATE_DF_OUT ?? join(tmpdir(), `df-${dfMode}.sqlite`),
      );
      return;
    }
    if (dfMode === "compare") {
      compareDfOutputs(
        process.env.VALIDATE_DF_REFERENCE ?? join(tmpdir(), "df-reference.sqlite"),
        process.env.VALIDATE_DF_GATEWAY ?? join(tmpdir(), "df-gateway.sqlite"),
      );
      return;
    }
    if (!only || only === "people") comparePeopleCounts(db);
    if (!only || only === "scores") compareInteractionScores(db);
    if (!only || only === "links") compareDirectScan(db);
    if (!only || only === "resolve") {
      compareLinkResolution(db, Number(process.env.VALIDATE_LINK_DOCS ?? 2_000));
    }
  } finally {
    db.close();
  }
  console.log(`\n${failures === 0 ? "all comparisons agree" : `${failures} comparison(s) DIFFER`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
