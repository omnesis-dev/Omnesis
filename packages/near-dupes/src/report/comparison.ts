#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { writeFileSync } from "node:fs";
import { defineCommand, runMain } from "citty";
import Database from "better-sqlite3";
import { CorpusReader } from "../corpus/reader.js";
import { DupeStore, defaultDupeDbPath } from "../store/repository.js";
import { DfTable } from "../algo/idf.js";
import { computeExclusivity } from "../algo/sketcher.js";
import { normalizeText, shingles } from "../algo/shingle.js";
import { connectedComponents } from "./clusters.js";

const HOME = process.env.HOME ?? "";
const DEFAULT_OMNESIS_DB = `${HOME}/.config/omnesis/omnesis.db`;
const ALGO_A = "mh128-k5-b16-r8-v1";
const ALGO_B = "ciws128-k5-b16-r8-idf-v1";
const ALGO_C = "ciws128-k5-b16-r8-idf-excl-v1";

interface PairBundle {
  docA: string;
  docB: string;
  aJ: number | null;
  bJ: number | null;
  cJ: number | null;
  cIntersection: number | null;
  cPairUniqueDf2: number | null;
  cPairUniqueDf5: number | null;
  /** intersection_size / min(|A|, |B|) — captures "doc is fully inside the other". */
  containmentMin: number | null;
  isExactDupe: boolean;
  isSameThread: boolean;
  /** Production-gate status from `gatePair` (C's scores). */
  cGateStatus: string | null;
  cGateFamily: string | null;
}

interface DocMeta {
  id: string;
  sourceId: string;
  title: string;
  sourceUrl: string | null;
  docType: string;
  content: string;
  shingleCount: number | null;
}

function fetchDocMeta(
  omnesisDb: Database.Database,
  store: DupeStore,
  ids: ReadonlySet<string>,
): Map<string, DocMeta> {
  const out = new Map<string, DocMeta>();
  if (ids.size === 0) return out;
  const placeholders = [...ids].map(() => "?").join(",");
  const rows = omnesisDb
    .prepare(
      `SELECT id, source_id, title, source_url, metadata, content
       FROM documents WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Array<{
    id: string;
    source_id: string;
    title: string;
    source_url: string | null;
    metadata: string;
    content: string;
  }>;
  // Shingle counts are recorded by every run; load them from the
  // most-canonical algo (C, which always carries them).
  const shingleRows = store.db
    .prepare(
      `SELECT document_id, shingle_count FROM document_minhash
       WHERE algo_version = ? AND document_id IN (${placeholders})`,
    )
    .all(ALGO_C, ...ids) as Array<{ document_id: string; shingle_count: number }>;
  const shingleCounts = new Map(shingleRows.map((r) => [r.document_id, r.shingle_count]));

  for (const r of rows) {
    let docType = "document";
    try {
      const m = JSON.parse(r.metadata) as { documentType?: string };
      if (typeof m.documentType === "string") docType = m.documentType;
    } catch {
      // ignore
    }
    out.set(r.id, {
      id: r.id,
      sourceId: r.source_id,
      title: r.title,
      sourceUrl: r.source_url,
      docType,
      content: r.content,
      shingleCount: shingleCounts.get(r.id) ?? null,
    });
  }
  return out;
}

interface LoadedPair {
  jaccard: number;
  intersection: number | null;
  pairUniqueDf2: number | null;
  pairUniqueDf5: number | null;
  isExactDupe: boolean;
  isSameThread: boolean;
  gateStatus: string | null;
  gateFamily: string | null;
}

function loadPairsByAlgo(store: DupeStore, algo: string, minJ: number): Map<string, LoadedPair> {
  const rows = store.db
    .prepare(
      `SELECT doc_a, doc_b, jaccard, intersection_size, pair_unique_df2, pair_unique_df5,
              is_exact_dupe, is_same_thread, gate_status, gate_family, annotated_at
       FROM pairs WHERE algo_version = ? AND jaccard >= ?`,
    )
    .all(algo, minJ) as Array<{
    doc_a: string;
    doc_b: string;
    jaccard: number;
    intersection_size: number | null;
    pair_unique_df2: number | null;
    pair_unique_df5: number | null;
    is_exact_dupe: number | null;
    is_same_thread: number | null;
    gate_status: string | null;
    gate_family: string | null;
    annotated_at: number | null;
  }>;
  const out = new Map<string, LoadedPair>();
  for (const r of rows) {
    if (r.annotated_at === null) {
      throw new Error(
        `pair (${r.doc_a}, ${r.doc_b}, ${algo}) is not annotated — run \`tsx packages/near-dupes/src/filters/annotate.ts annotate\` first`,
      );
    }
    out.set(`${r.doc_a}\x00${r.doc_b}`, {
      jaccard: r.jaccard,
      intersection: r.intersection_size,
      pairUniqueDf2: r.pair_unique_df2,
      pairUniqueDf5: r.pair_unique_df5,
      isExactDupe: r.is_exact_dupe === 1,
      isSameThread: r.is_same_thread === 1,
      gateStatus: r.gate_status,
      gateFamily: r.gate_family,
    });
  }
  return out;
}

function shortTitle(t: string, n = 60): string {
  const oneLine = t.replace(/\s+/g, " ").trim();
  return oneLine.length <= n ? oneLine : oneLine.slice(0, n - 1) + "…";
}

function shortSource(src: string): string {
  // gmail:jamesbond@... → gmail; google-drive:... → drive; etc.
  const [base] = src.split(":");
  if (base === "google-drive") return "drive";
  if (base === "outlook-email") return "outlook";
  if (base === "whatsapp-messages") return "whatsapp";
  if (base === "notion-pages") return "notion-pg";
  if (base === "notion-databases") return "notion-db";
  return base;
}

const report = defineCommand({
  meta: {
    name: "comparison",
    description: "Generate the A/B/C comparison report markdown.",
  },
  args: {
    dupesDb: { type: "string", default: defaultDupeDbPath() },
    omnesisDb: { type: "string", default: DEFAULT_OMNESIS_DB },
    minJ: { type: "string", default: "0.75" },
    out: { type: "string", default: "/tmp/near-dupes-study/comparison.md" },
  },
  run({ args }) {
    const store = new DupeStore(args.dupesDb);
    const omnesisDb = new Database(args.omnesisDb, { readonly: true, fileMustExist: true });
    const minJ = Number(args.minJ);

    process.stderr.write(`Loading pairs at J ≥ ${minJ}…\n`);
    const pairsA = loadPairsByAlgo(store, ALGO_A, minJ);
    const pairsB = loadPairsByAlgo(store, ALGO_B, minJ);
    const pairsC = loadPairsByAlgo(store, ALGO_C, minJ);

    const unionKeys = new Set<string>([...pairsA.keys(), ...pairsB.keys(), ...pairsC.keys()]);
    process.stderr.write(
      `A=${pairsA.size}  B=${pairsB.size}  C=${pairsC.size}  union=${unionKeys.size}\n`,
    );

    const allIds = new Set<string>();
    for (const k of unionKeys) {
      const [a, b] = k.split("\x00");
      allIds.add(a);
      allIds.add(b);
    }
    const docs = fetchDocMeta(omnesisDb, store, allIds);
    process.stderr.write(`Fetched ${docs.size}/${allIds.size} document metas\n`);

    // Build the DfTable once so we can patch exclusivity for pairs that
    // were recorded under Run A and Run B (neither computed it natively).
    process.stderr.write(`Building DfTable from the live corpus…\n`);
    const corpus = new CorpusReader(args.omnesisDb, {
      includeTypes: new Set(["email", "note", "document", "attachment", "file"]),
      minContentLength: 200,
      maxContentLength: 200000,
    });
    const df = new DfTable();
    let scanned = 0;
    for (const d of corpus.stream()) {
      const sh = shingles(normalizeText(d.content, { stripQuotes: true }), 5);
      if (sh.size === 0) continue;
      df.observe(sh);
      scanned++;
      if (scanned % 2000 === 0) process.stderr.write(`  ${scanned} docs scanned\n`);
    }
    corpus.close();
    process.stderr.write(`DfTable built: ${scanned} docs, ${df.size()} unique shingles\n`);

    // Patch exclusivity for any pair that lacks it (re-shingles both
    // sides; only runs when the row didn't already carry the columns).
    const shingleCache = new Map<string, Set<string>>();
    const shinglesOf = (id: string): Set<string> | null => {
      const cached = shingleCache.get(id);
      if (cached) return cached;
      const m = docs.get(id);
      if (!m) return null;
      const sh = shingles(normalizeText(m.content, { stripQuotes: true }), 5);
      shingleCache.set(id, sh);
      return sh;
    };

    const bundles: PairBundle[] = [];
    let patched = 0;
    for (const k of unionKeys) {
      const [docA, docB] = k.split("\x00");
      const a = pairsA.get(k);
      const b = pairsB.get(k);
      const c = pairsC.get(k);

      let cIntersection = c?.intersection ?? null;
      let cPairUniqueDf2 = c?.pairUniqueDf2 ?? null;
      let cPairUniqueDf5 = c?.pairUniqueDf5 ?? null;

      if (cIntersection === null || cPairUniqueDf2 === null) {
        const shA = shinglesOf(docA);
        const shB = shinglesOf(docB);
        if (shA && shB) {
          const e = computeExclusivity(df, shA, shB);
          cIntersection = e.intersectionSize;
          cPairUniqueDf2 = e.pairUniqueDf2;
          cPairUniqueDf5 = e.pairUniqueDf5;
          patched++;
        }
      }

      // Any annotated row in any algo agrees on the filter flags
      // (the underlying doc-meta is the same), so coalesce.
      const anyAnnotated = a ?? b ?? c;
      const isExactDupe = anyAnnotated?.isExactDupe ?? false;
      const isSameThread = anyAnnotated?.isSameThread ?? false;

      // Containment: intersection / min(|A|, |B|). Captures
      // "one doc is essentially contained in the other" — handles
      // the large-PDF-multi-version case where df2 reads 0 because
      // the shared content also appears in adjacent versions in the
      // corpus, but the pair is clearly a single-document family.
      let containmentMin: number | null = null;
      if (cIntersection !== null) {
        const shA = docs.get(docA)?.shingleCount ?? null;
        const shB = docs.get(docB)?.shingleCount ?? null;
        if (shA !== null && shB !== null) {
          const m = Math.min(shA, shB);
          if (m > 0) containmentMin = cIntersection / m;
        }
      }

      bundles.push({
        docA,
        docB,
        aJ: a?.jaccard ?? null,
        bJ: b?.jaccard ?? null,
        cJ: c?.jaccard ?? null,
        cIntersection,
        cPairUniqueDf2,
        cPairUniqueDf5,
        containmentMin,
        isExactDupe,
        isSameThread,
        cGateStatus: c?.gateStatus ?? null,
        cGateFamily: c?.gateFamily ?? null,
      });
    }
    process.stderr.write(`Patched exclusivity for ${patched} pairs lacking it\n`);

    bundles.sort((x, y) => {
      const mx = Math.max(x.aJ ?? 0, x.bJ ?? 0, x.cJ ?? 0);
      const my = Math.max(y.aJ ?? 0, y.bJ ?? 0, y.cJ ?? 0);
      return my - mx;
    });

    const md = renderMarkdown(bundles, docs, df.totalDocs, df.size(), minJ);
    const clustersMd = renderClusters(bundles, docs, minJ);
    writeFileSync(args.out, md + "\n" + clustersMd);
    process.stderr.write(`Wrote ${args.out} (${md.length} bytes)\n`);

    store.close();
    omnesisDb.close();
  },
});

function renderMarkdown(
  allBundles: PairBundle[],
  docs: Map<string, DocMeta>,
  totalDocs: number,
  uniqueShingles: number,
  minJ: number,
): string {
  const totalExact = allBundles.filter((b) => b.isExactDupe).length;
  const totalThread = allBundles.filter((b) => !b.isExactDupe && b.isSameThread).length;
  // Visible bundles in the main table: suppress pairs already covered
  // by exact-duplicate or same-thread edges in Omnesis.
  const bundles = allBundles.filter((b) => !b.isExactDupe && !b.isSameThread);

  const passA = (b: PairBundle) => b.aJ !== null && b.aJ >= minJ;
  const passB = (b: PairBundle) => b.bJ !== null && b.bJ >= minJ;
  const passC_jOnly = (b: PairBundle) => b.cJ !== null && b.cJ >= minJ;
  const passC_strict = (b: PairBundle) =>
    b.cJ !== null && b.cJ >= minJ && (b.cPairUniqueDf2 ?? 0) >= 1;
  const passC_lenient = (b: PairBundle) =>
    b.cJ !== null && b.cJ >= minJ && (b.cPairUniqueDf5 ?? 0) >= 3;
  /**
   * Recommended composite: pair-unique content OR essentially-contained.
   * The containment OR-branch catches the "two near-identical versions of
   * a large PDF (lease, multi-page quote) that also have a few other
   * copies in the corpus" case that `df2 ≥ 1` misses.
   */
  const passC_composite = (b: PairBundle) =>
    b.cJ !== null &&
    b.cJ >= minJ &&
    ((b.cPairUniqueDf2 ?? 0) >= 1 || (b.containmentMin ?? 0) >= 0.95);
  /**
   * Production gate: source-family-aware thresholds + automated-sender
   * suppression. This is the answer for "what would Omnesis surface as
   * a near-duplicate edge?".
   */
  const passC_gate = (b: PairBundle) => b.cGateStatus === "pass";

  const countA = bundles.filter(passA).length;
  const countB = bundles.filter(passB).length;
  const countC = bundles.filter(passC_jOnly).length;
  const countCStrict = bundles.filter(passC_strict).length;
  const countCLenient = bundles.filter(passC_lenient).length;
  const countCComposite = bundles.filter(passC_composite).length;
  const countCGate = bundles.filter(passC_gate).length;
  const countCGateEmail = bundles.filter((b) => passC_gate(b) && b.cGateFamily === "email").length;
  const countCGateFile = bundles.filter(
    (b) => passC_gate(b) && b.cGateFamily === "file-like",
  ).length;
  const countCAutomated = bundles.filter((b) => b.cGateStatus === "automated-sender").length;
  const countCBelow = bundles.filter((b) => b.cGateStatus === "below-threshold").length;
  const rawCountA = allBundles.filter(passA).length;
  const rawCountB = allBundles.filter(passB).length;
  const rawCountC = allBundles.filter(passC_jOnly).length;

  const lines: string[] = [];
  lines.push(`# Near-duplicate detection: A / B / C comparison`);
  lines.push(``);
  lines.push(
    `Three iterations evaluated on the same corpus subset (${totalDocs} documents, ${uniqueShingles} unique 5-word shingles).`,
  );
  lines.push(``);
  lines.push(`- **Run A — vanilla MinHash + plain Jaccard.** Algorithm version \`${ALGO_A}\`.`);
  lines.push(
    `- **Run B — Ioffe ICWS weighted MinHash + IDF-weighted Jaccard.** Algorithm version \`${ALGO_B}\`.`,
  );
  lines.push(
    `- **Run C — Run B + per-pair exclusivity scoring.** Algorithm version \`${ALGO_C}\`. At verification time records \`intersection_size\`, \`pair_unique_df2\` (shingles in A∩B with corpus DF ≤ 2), and \`pair_unique_df5\` (DF ≤ 5).`,
  );
  lines.push(``);
  lines.push(`Pair threshold for "matched" in this report: **J ≥ ${minJ}**.`);
  lines.push(``);
  lines.push(`## Edge-suppression filters (applied before display)`);
  lines.push(``);
  lines.push(
    `Omnesis already represents two specific relationships via dedicated edges, so the near-duplicate edge should not duplicate them. These filters are encoded in \`packages/near-dupes/src/filters/edge-filters.ts\` and applied to every pair via the standalone \`annotate\` CLI stage:`,
  );
  lines.push(``);
  lines.push(
    `1. **\`exact-dupe\`** — both docs share the same \`content_hash\` (or \`extracted_content_hash\` for attachments). Omnesis carries an exact-duplicate edge for these; the near-duplicate edge would be redundant. Filtered from this report.`,
  );
  lines.push(
    `2. **\`same-thread\`** — both docs are emails with the same provider \`threadId\`. Replies embed parent bodies, so same-thread pairs naturally trigger the near-duplicate signal — but thread membership is its own well-defined relationship. Filtered from this report.`,
  );
  lines.push(``);
  lines.push(
    `Suppressed counts across all algorithms (J ≥ 0.5, the algorithm's record threshold): **${totalExact} exact-dupes**, **${totalThread} same-thread emails**.`,
  );
  lines.push(``);
  lines.push(`Effect on the at-J ≥ ${minJ} matched-pair counts:`);
  lines.push(``);
  lines.push(`| Algorithm | Raw pairs (incl. suppressed) | After filters | Suppressed |`);
  lines.push(`| --- | ---: | ---: | ---: |`);
  lines.push(`| A | ${rawCountA} | ${countA} | ${rawCountA - countA} |`);
  lines.push(`| B | ${rawCountB} | ${countB} | ${rawCountB - countB} |`);
  lines.push(`| C (J only) | ${rawCountC} | ${countC} | ${rawCountC - countC} |`);
  lines.push(``);
  lines.push(`## Pair counts by algorithm (after filters)`);
  lines.push(``);
  lines.push(`| Algorithm | Match definition | Pairs |`);
  lines.push(`| --- | --- | ---: |`);
  lines.push(`| A | \`J ≥ ${minJ}\` | ${countA} |`);
  lines.push(`| B | \`J ≥ ${minJ}\` | ${countB} |`);
  lines.push(`| C | \`J ≥ ${minJ}\` (J score only) | ${countC} |`);
  lines.push(`| C-strict | \`J ≥ ${minJ}\` AND \`pair_unique_df2 ≥ 1\` | ${countCStrict} |`);
  lines.push(`| C-lenient | \`J ≥ ${minJ}\` AND \`pair_unique_df5 ≥ 3\` | ${countCLenient} |`);
  lines.push(
    `| **C-composite** | \`J ≥ ${minJ}\` AND (\`pair_unique_df2 ≥ 1\` OR \`containment_min ≥ 0.95\`) | **${countCComposite}** |`,
  );
  lines.push(
    `| **C-production** | C-composite AND production gate (source-family thresholds + automated-sender allowlist) | **${countCGate}** (email ${countCGateEmail}, file ${countCGateFile}) |`,
  );
  lines.push(``);
  lines.push(`## Production gate dispositions (Run C)`);
  lines.push(``);
  lines.push(
    `The gate distinguishes between "rejected for product reasons" and "below the score bar":`,
  );
  lines.push(``);
  lines.push(`| Status | Pairs |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| **pass** | ${countCGate} |`);
  lines.push(
    `| automated-sender (suppressed via noreply / mailer-daemon allowlist) | ${countCAutomated} |`,
  );
  lines.push(`| below-threshold (didn't clear source-family scores) | ${countCBelow} |`);
  lines.push(``);
  lines.push(`## Disagreement matrix (counts)`);
  lines.push(``);
  const inA = (b: PairBundle) => passA(b);
  const inB = (b: PairBundle) => passB(b);
  const inC = (b: PairBundle) => passC_gate(b);
  const all3 = bundles.filter((b) => inA(b) && inB(b) && inC(b)).length;
  const aOnly = bundles.filter((b) => inA(b) && !inB(b) && !inC(b)).length;
  const bOnly = bundles.filter((b) => !inA(b) && inB(b) && !inC(b)).length;
  const cOnly = bundles.filter((b) => !inA(b) && !inB(b) && inC(b)).length;
  const aAndB = bundles.filter((b) => inA(b) && inB(b) && !inC(b)).length;
  const aAndC = bundles.filter((b) => inA(b) && !inB(b) && inC(b)).length;
  const bAndC = bundles.filter((b) => !inA(b) && inB(b) && inC(b)).length;
  lines.push(
    `Using **C-production** as the C definition (C-composite + source-family gate + automated-sender allowlist):`,
  );
  lines.push(``);
  lines.push(`| Combination | Pairs |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| All three (A ∧ B ∧ C) | ${all3} |`);
  lines.push(`| A ∧ B (rejected by C — template) | ${aAndB} |`);
  lines.push(`| A ∧ C (B's IDF rejected) | ${aAndC} |`);
  lines.push(`| B ∧ C (A's vanilla missed) | ${bAndC} |`);
  lines.push(`| A only | ${aOnly} |`);
  lines.push(`| B only | ${bOnly} |`);
  lines.push(`| C only | ${cOnly} |`);
  lines.push(``);
  lines.push(`## Pair-by-pair table`);
  lines.push(``);
  lines.push(
    `Union of all pairs scoring \`J ≥ ${minJ}\` in any algorithm. Sorted by max similarity.`,
  );
  lines.push(``);
  lines.push(`Columns:`);
  lines.push(
    `- \`A.J\`, \`B.J\`, \`C.J\` — Jaccard score under each algorithm (\`—\` = not detected at the threshold).`,
  );
  lines.push(`- \`∩\` — intersection size (shared shingles).`);
  lines.push(
    `- \`df≤2\` — count of shared shingles whose corpus DF is ≤ 2 (i.e. unique to this pair).`,
  );
  lines.push(`- \`df≤5\` — count of shared shingles whose corpus DF is ≤ 5.`);
  lines.push(
    `- \`contain\` — \`intersection_size / min(|A|, |B|)\`. 1.0 means one doc is fully contained in the other (e.g. two copies of a long PDF).`,
  );
  lines.push(
    `- \`gate\` — production-gate status: \`pass\` (would emit an edge), \`automated-sender\` (sender is on the noreply/mailer-daemon allowlist), \`below-threshold\` (didn't clear source-family scores).`,
  );
  lines.push(``);
  lines.push(`| # | Doc A | Doc B | A.J | B.J | C.J | ∩ | df≤2 | df≤5 | contain | gate |`);
  lines.push(`| -:| --- | --- | -: | -: | -: | -: | -: | -: | -: | -: |`);
  let i = 1;
  for (const b of bundles) {
    const a = docs.get(b.docA);
    const bb = docs.get(b.docB);
    const aLabel = a
      ? `${shortSource(a.sourceId)} \`${b.docA.slice(0, 8)}\` ${shortTitle(a.title)}`
      : b.docA;
    const bLabel = bb
      ? `${shortSource(bb.sourceId)} \`${b.docB.slice(0, 8)}\` ${shortTitle(bb.title)}`
      : b.docB;
    const aWithLink = a?.sourceUrl ? `[${aLabel}](${a.sourceUrl})` : aLabel;
    const bWithLink = bb?.sourceUrl ? `[${bLabel}](${bb.sourceUrl})` : bLabel;
    const aJ = b.aJ === null ? "—" : b.aJ.toFixed(3);
    const bJ = b.bJ === null ? "—" : b.bJ.toFixed(3);
    const cJ = b.cJ === null ? "—" : b.cJ.toFixed(3);
    const inter = b.cIntersection ?? "—";
    const u2 = b.cPairUniqueDf2 ?? "—";
    const u5 = b.cPairUniqueDf5 ?? "—";
    const cm = b.containmentMin === null ? "—" : b.containmentMin.toFixed(3);
    const gate = b.cGateStatus ?? "—";
    lines.push(
      `| ${i} | ${aWithLink} | ${bWithLink} | ${aJ} | ${bJ} | ${cJ} | ${inter} | ${u2} | ${u5} | ${cm} | ${gate} |`,
    );
    i++;
  }
  lines.push(``);
  return lines.join("\n");
}

function clustersForAlgo(bundles: PairBundle[], pass: (b: PairBundle) => boolean): string[][] {
  const edges: Array<[string, string]> = [];
  for (const b of bundles) {
    if (b.isExactDupe || b.isSameThread) continue;
    if (pass(b)) edges.push([b.docA, b.docB]);
  }
  return connectedComponents(edges);
}

function sizeHistogram(clusters: string[][]): Map<number, number> {
  const h = new Map<number, number>();
  for (const c of clusters) h.set(c.length, (h.get(c.length) ?? 0) + 1);
  return h;
}

function renderClusters(bundles: PairBundle[], docs: Map<string, DocMeta>, minJ: number): string {
  const passA = (b: PairBundle) => b.aJ !== null && b.aJ >= minJ;
  const passB = (b: PairBundle) => b.bJ !== null && b.bJ >= minJ;
  const passCProduction = (b: PairBundle) => b.cGateStatus === "pass";

  const aClusters = clustersForAlgo(bundles, passA);
  const bClusters = clustersForAlgo(bundles, passB);
  const cClusters = clustersForAlgo(bundles, passCProduction);

  // Build lookups: docId → cluster index within each algo (used to
  // show how an A-cluster fragments under B / C).
  const clusterIdxOf = (clusters: string[][]): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < clusters.length; i++) for (const id of clusters[i]) m.set(id, i);
    return m;
  };
  const aIdx = clusterIdxOf(aClusters);
  const bIdx = clusterIdxOf(bClusters);
  const cIdx = clusterIdxOf(cClusters);

  // Given a cluster's members and another algorithm's cluster index,
  // return the size of the largest sub-cluster of `members` that
  // co-occurs in a single cluster of the other algorithm.
  const maxOverlap = (members: ReadonlyArray<string>, otherIdx: Map<string, number>): number => {
    const groups = new Map<number, number>();
    for (const id of members) {
      const i = otherIdx.get(id);
      if (i === undefined) continue;
      groups.set(i, (groups.get(i) ?? 0) + 1);
    }
    let max = 0;
    for (const n of groups.values()) if (n > max) max = n;
    return max;
  };

  type Status = "full" | "partial" | "absent";
  const statusFor = (members: ReadonlyArray<string>, otherIdx: Map<string, number>): Status => {
    const m = maxOverlap(members, otherIdx);
    if (m >= members.length) return "full";
    if (m >= 2) return "partial";
    return "absent";
  };
  const badge = (label: string, status: Status): string => {
    // Emoji + label, plus an HTML span so the renderer can style.
    const emoji = status === "full" ? "🟢" : status === "partial" ? "🟡" : "⚪";
    return `<span class="cb cb-${status}">${emoji} ${label}</span>`;
  };
  const badgesFor = (members: ReadonlyArray<string>, selfAlgo: "A" | "B" | "C"): string => {
    const a = selfAlgo === "A" ? ("full" as Status) : statusFor(members, aIdx);
    const b = selfAlgo === "B" ? ("full" as Status) : statusFor(members, bIdx);
    const c = selfAlgo === "C" ? ("full" as Status) : statusFor(members, cIdx);
    return `${badge("A", a)} ${badge("B", b)} ${badge("C-production", c)}`;
  };

  const lines: string[] = [];
  lines.push(``);
  lines.push(`## Clusters`);
  lines.push(``);
  lines.push(
    `Connected components over each algorithm's surviving (filter-passing) edges at J ≥ ${minJ}. ` +
      `Largest clusters first.`,
  );
  lines.push(``);
  lines.push(`Counts at a glance:`);
  lines.push(``);
  lines.push(`| Algorithm | Clusters | Docs in clusters | Largest cluster |`);
  lines.push(`| --- | ---: | ---: | ---: |`);
  for (const [name, cs] of [
    ["A (vanilla)", aClusters],
    ["B (IDF)", bClusters],
    ["C-production (composite + source-family gate + automated-sender allowlist)", cClusters],
  ] as const) {
    const docsIn = cs.reduce((s, c) => s + c.length, 0);
    const largest = cs[0]?.length ?? 0;
    lines.push(`| ${name} | ${cs.length} | ${docsIn} | ${largest} |`);
  }
  lines.push(``);
  lines.push(`Each cluster heading carries a glance-badge for all three algorithms:`);
  lines.push(``);
  lines.push(
    `- 🟢 **full** — every member of this cluster sits inside one cluster in that algorithm.`,
  );
  lines.push(
    `- 🟡 **partial** — at least two members of this cluster are linked in that algorithm, but the cluster isn't fully preserved.`,
  );
  lines.push(`- ⚪ **absent** — at most one member appears in any cluster of that algorithm.`);

  for (const [section, clusters, showXref, selfAlgo] of [
    ["A", aClusters, true, "A"],
    ["B", bClusters, false, "B"],
    ["C-production", cClusters, false, "C"],
  ] as const) {
    lines.push(``);
    lines.push(`### Clusters under ${section}`);
    lines.push(``);
    const hist = sizeHistogram(clusters);
    if (hist.size > 0) {
      lines.push(
        `Size distribution: ` +
          [...hist.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([size, n]) => `**${size}**: ${n}`)
            .join(" · "),
      );
      lines.push(``);
    }
    const top = clusters.slice(0, 30);
    if (top.length === 0) {
      lines.push(`_No clusters._`);
      continue;
    }
    for (let i = 0; i < top.length; i++) {
      const c = top[i];
      lines.push(`#### ${section} cluster ${i + 1} — size ${c.length} · ${badgesFor(c, selfAlgo)}`);
      if (showXref) {
        // How does this A-cluster look under B / C?
        const bGroups = new Map<number, number>();
        const cGroups = new Map<number, number>();
        let bOrphans = 0;
        let cOrphans = 0;
        for (const id of c) {
          const bi = bIdx.get(id);
          if (bi === undefined) bOrphans++;
          else bGroups.set(bi, (bGroups.get(bi) ?? 0) + 1);
          const ci = cIdx.get(id);
          if (ci === undefined) cOrphans++;
          else cGroups.set(ci, (cGroups.get(ci) ?? 0) + 1);
        }
        const summarize = (groups: Map<number, number>, orphans: number) => {
          const parts = [...groups.values()].sort((a, b) => b - a).map(String);
          if (orphans > 0) parts.push(`${orphans} singleton${orphans > 1 ? "s" : ""}`);
          return parts.length === 0 ? "_no edges_" : parts.join(" + ");
        };
        lines.push(
          `Fragmentation under stricter algos — ` +
            `**B**: ${summarize(bGroups, bOrphans)} · ` +
            `**C-production**: ${summarize(cGroups, cOrphans)}`,
        );
      }
      lines.push(``);
      const sources = new Map<string, number>();
      const types = new Map<string, number>();
      for (const id of c) {
        const m = docs.get(id);
        if (!m) continue;
        const src = shortSource(m.sourceId);
        sources.set(src, (sources.get(src) ?? 0) + 1);
        types.set(m.docType, (types.get(m.docType) ?? 0) + 1);
      }
      const srcSummary = [...sources.entries()].map(([s, n]) => `${s}×${n}`).join(", ");
      const typeSummary = [...types.entries()].map(([t, n]) => `${t}×${n}`).join(", ");
      lines.push(`Sources: ${srcSummary} · Types: ${typeSummary}`);
      lines.push(``);
      const memberCap = Math.min(c.length, 25);
      lines.push(`| Doc | Title |`);
      lines.push(`| --- | --- |`);
      for (const id of c.slice(0, memberCap)) {
        const m = docs.get(id);
        if (!m) {
          lines.push(`| \`${id.slice(0, 8)}\` (unknown) | — |`);
          continue;
        }
        const label = `${shortSource(m.sourceId)} \`${id.slice(0, 8)}\``;
        const link = m.sourceUrl ? `[${label}](${m.sourceUrl})` : label;
        lines.push(`| ${link} | ${shortTitle(m.title, 80)} |`);
      }
      if (c.length > memberCap) {
        lines.push(`| _…+${c.length - memberCap} more_ | _truncated for display_ |`);
      }
      lines.push(``);
    }
    if (clusters.length > top.length) {
      lines.push(`_…+${clusters.length - top.length} more ${section} clusters not shown._`);
      lines.push(``);
    }
  }

  return lines.join("\n");
}

const main = defineCommand({
  meta: {
    name: "near-dupes-comparison",
    description: "Generate the A/B/C comparison study report.",
  },
  subCommands: { report },
});

void runMain(main);
