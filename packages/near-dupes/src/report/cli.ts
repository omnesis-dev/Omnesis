#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand, runMain } from "citty";
import { DupeStore, defaultDupeDbPath } from "../store/repository.js";
import { CorpusReader } from "../corpus/reader.js";
import { connectedComponents } from "./clusters.js";

const HOME = process.env.HOME ?? "";
const DEFAULT_OMNESIS_DB = `${HOME}/.config/omnesis/omnesis.db`;

interface PairRowDb {
  doc_a: string;
  doc_b: string;
  jaccard: number;
  sig_similarity: number;
  run_id: string;
}

function loadPairs(store: DupeStore, algoVersion: string, minJaccard: number): PairRowDb[] {
  return store.db
    .prepare(
      `SELECT doc_a, doc_b, jaccard, sig_similarity, run_id
       FROM pairs WHERE algo_version = ? AND jaccard >= ?
       ORDER BY jaccard DESC`,
    )
    .all(algoVersion, minJaccard) as PairRowDb[];
}

function getDocMeta(
  store: DupeStore,
  algoVersion: string,
  ids: ReadonlySet<string>,
): Map<string, { docType: string; pluginId: string; sourceCreatedAt: number | null }> {
  if (ids.size === 0) return new Map();
  const placeholders = [...ids].map(() => "?").join(",");
  const rows = store.db
    .prepare(
      `SELECT document_id, doc_type, plugin_id, source_created_at
       FROM document_minhash
       WHERE algo_version = ? AND document_id IN (${placeholders})`,
    )
    .all(algoVersion, ...ids) as Array<{
    document_id: string;
    doc_type: string;
    plugin_id: string;
    source_created_at: number | null;
  }>;
  const out = new Map<
    string,
    { docType: string; pluginId: string; sourceCreatedAt: number | null }
  >();
  for (const r of rows) {
    out.set(r.document_id, {
      docType: r.doc_type,
      pluginId: r.plugin_id,
      sourceCreatedAt: r.source_created_at,
    });
  }
  return out;
}

const stats = defineCommand({
  meta: { name: "stats", description: "Overall counts and per-source breakdown." },
  args: {
    dupesDb: { type: "string", default: defaultDupeDbPath() },
    algoVersion: { type: "string", default: "mh128-k5-b16-r8-v1" },
  },
  run({ args }) {
    const store = new DupeStore(args.dupesDb);
    const sigs = store.countMinhashes(args.algoVersion);
    const pairsTotal = store.countPairs(args.algoVersion, 0);
    process.stdout.write(`algo: ${args.algoVersion}\n`);
    process.stdout.write(`signatures: ${sigs}\n`);
    process.stdout.write(`pairs (any jaccard): ${pairsTotal}\n`);

    for (const t of [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]) {
      const n = store.countPairs(args.algoVersion, t);
      process.stdout.write(`  jaccard ≥ ${t.toFixed(2)}: ${n}\n`);
    }

    const perSource = store.db
      .prepare(
        `SELECT plugin_id, COUNT(*) AS n FROM document_minhash
         WHERE algo_version = ? GROUP BY plugin_id ORDER BY n DESC`,
      )
      .all(args.algoVersion) as Array<{ plugin_id: string; n: number }>;
    process.stdout.write(`\nsignatures by source:\n`);
    for (const r of perSource) process.stdout.write(`  ${r.plugin_id.padEnd(40)} ${r.n}\n`);

    const perType = store.db
      .prepare(
        `SELECT doc_type, COUNT(*) AS n FROM document_minhash
         WHERE algo_version = ? GROUP BY doc_type ORDER BY n DESC`,
      )
      .all(args.algoVersion) as Array<{ doc_type: string; n: number }>;
    process.stdout.write(`\nsignatures by type:\n`);
    for (const r of perType) process.stdout.write(`  ${r.doc_type.padEnd(20)} ${r.n}\n`);

    store.close();
  },
});

const clusters = defineCommand({
  meta: {
    name: "clusters",
    description: "Connected components over pairs at a threshold. Largest first.",
  },
  args: {
    dupesDb: { type: "string", default: defaultDupeDbPath() },
    algoVersion: { type: "string", default: "mh128-k5-b16-r8-v1" },
    threshold: { type: "string", default: "0.75" },
    top: { type: "string", default: "20" },
    maxMembers: {
      type: "string",
      description: "Show at most this many member ids per cluster.",
      default: "10",
    },
  },
  run({ args }) {
    const store = new DupeStore(args.dupesDb);
    const pairs = loadPairs(store, args.algoVersion, Number(args.threshold));
    const groups = connectedComponents(pairs.map((p) => [p.doc_a, p.doc_b] as const));
    process.stdout.write(
      `threshold ≥ ${args.threshold}: ${pairs.length} pairs in ${groups.length} clusters\n\n`,
    );

    const allIds = new Set<string>();
    for (const g of groups.slice(0, Number(args.top))) for (const id of g) allIds.add(id);
    const meta = getDocMeta(store, args.algoVersion, allIds);

    const buckets = countBySize(groups);
    process.stdout.write(`cluster size distribution:\n`);
    for (const [size, count] of buckets) {
      process.stdout.write(`  size ${size.padEnd(6)} ${count}\n`);
    }
    process.stdout.write(`\n`);

    const top = groups.slice(0, Number(args.top));
    for (let i = 0; i < top.length; i++) {
      const g = top[i];
      const sources = new Set<string>();
      const types = new Set<string>();
      for (const id of g) {
        const m = meta.get(id);
        if (m) {
          sources.add(m.pluginId);
          types.add(m.docType);
        }
      }
      process.stdout.write(
        `#${i + 1} size=${g.length} sources={${[...sources].join(",")}} types={${[...types].join(",")}}\n`,
      );
      for (const id of g.slice(0, Number(args.maxMembers))) {
        const m = meta.get(id);
        process.stdout.write(`    ${id}  ${m?.docType ?? "?"}  ${m?.pluginId ?? "?"}\n`);
      }
      if (g.length > Number(args.maxMembers)) {
        process.stdout.write(`    … +${g.length - Number(args.maxMembers)} more\n`);
      }
    }
    store.close();
  },
});

function countBySize(groups: string[][]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const g of groups) {
    const key = g.length.toString();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
}

const show = defineCommand({
  meta: { name: "show", description: "Show near-duplicates of a single document." },
  args: {
    dupesDb: { type: "string", default: defaultDupeDbPath() },
    omnesisDb: { type: "string", default: DEFAULT_OMNESIS_DB },
    algoVersion: { type: "string", default: "mh128-k5-b16-r8-v1" },
    docId: { type: "positional", required: true },
    threshold: { type: "string", default: "0" },
  },
  run({ args }) {
    const store = new DupeStore(args.dupesDb);
    const corpus = new CorpusReader(args.omnesisDb);
    const self = corpus.getContent(args.docId);
    process.stdout.write(`document: ${args.docId}\n`);
    if (self) {
      process.stdout.write(`  type=${self.docType}\n`);
      process.stdout.write(`  title=${self.title.slice(0, 120)}\n`);
    }
    const rows = store.db
      .prepare(
        `SELECT doc_a, doc_b, jaccard, sig_similarity FROM pairs
         WHERE algo_version = ? AND (doc_a = ? OR doc_b = ?) AND jaccard >= ?
         ORDER BY jaccard DESC`,
      )
      .all(args.algoVersion, args.docId, args.docId, Number(args.threshold)) as Array<{
      doc_a: string;
      doc_b: string;
      jaccard: number;
      sig_similarity: number;
    }>;
    process.stdout.write(`\nnear-duplicates (${rows.length}):\n`);
    for (const r of rows) {
      const other = r.doc_a === args.docId ? r.doc_b : r.doc_a;
      const m = corpus.getContent(other);
      process.stdout.write(
        `  J=${r.jaccard.toFixed(3)}  sig≈${r.sig_similarity.toFixed(3)}  ${other}  ` +
          `${m?.docType ?? "?"}  ${m?.title.slice(0, 80) ?? ""}\n`,
      );
    }
    corpus.close();
    store.close();
  },
});

const sample = defineCommand({
  meta: {
    name: "sample",
    description: "Random sample of pairs in a Jaccard band — for hand-labelling precision.",
  },
  args: {
    dupesDb: { type: "string", default: defaultDupeDbPath() },
    omnesisDb: { type: "string", default: DEFAULT_OMNESIS_DB },
    algoVersion: { type: "string", default: "mh128-k5-b16-r8-v1" },
    min: { type: "string", default: "0.75" },
    max: { type: "string", default: "0.85" },
    n: { type: "string", default: "25" },
  },
  run({ args }) {
    const store = new DupeStore(args.dupesDb);
    const corpus = new CorpusReader(args.omnesisDb);
    const rows = store.db
      .prepare(
        `SELECT doc_a, doc_b, jaccard FROM pairs
         WHERE algo_version = ? AND jaccard >= ? AND jaccard < ?
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(args.algoVersion, Number(args.min), Number(args.max), Number(args.n)) as Array<{
      doc_a: string;
      doc_b: string;
      jaccard: number;
    }>;
    process.stdout.write(
      `sample of ${rows.length} pairs in jaccard ∈ [${args.min}, ${args.max})\n\n`,
    );
    for (const r of rows) {
      const a = corpus.getContent(r.doc_a);
      const b = corpus.getContent(r.doc_b);
      process.stdout.write(`J=${r.jaccard.toFixed(3)}\n`);
      process.stdout.write(`  A ${r.doc_a}  ${a?.docType ?? "?"}\n`);
      process.stdout.write(`    title: ${a?.title.slice(0, 120) ?? ""}\n`);
      process.stdout.write(`    text:  ${(a?.content ?? "").replace(/\s+/g, " ").slice(0, 160)}\n`);
      process.stdout.write(`  B ${r.doc_b}  ${b?.docType ?? "?"}\n`);
      process.stdout.write(`    title: ${b?.title.slice(0, 120) ?? ""}\n`);
      process.stdout.write(
        `    text:  ${(b?.content ?? "").replace(/\s+/g, " ").slice(0, 160)}\n\n`,
      );
    }
    corpus.close();
    store.close();
  },
});

const crossSource = defineCommand({
  meta: {
    name: "cross-source",
    description: "Clusters that span multiple sources — the substrate-payoff signal.",
  },
  args: {
    dupesDb: { type: "string", default: defaultDupeDbPath() },
    algoVersion: { type: "string", default: "mh128-k5-b16-r8-v1" },
    threshold: { type: "string", default: "0.75" },
    minSources: { type: "string", default: "2" },
    top: { type: "string", default: "30" },
  },
  run({ args }) {
    const store = new DupeStore(args.dupesDb);
    const pairs = loadPairs(store, args.algoVersion, Number(args.threshold));
    const groups = connectedComponents(pairs.map((p) => [p.doc_a, p.doc_b] as const));
    const allIds = new Set<string>();
    for (const g of groups) for (const id of g) allIds.add(id);
    const meta = getDocMeta(store, args.algoVersion, allIds);

    const annotated = groups
      .map((g) => {
        const sources = new Set(g.map((id) => meta.get(id)?.pluginId ?? "?"));
        return { ids: g, sources };
      })
      .filter((c) => c.sources.size >= Number(args.minSources))
      .sort((a, b) => b.sources.size - a.sources.size || b.ids.length - a.ids.length)
      .slice(0, Number(args.top));

    process.stdout.write(
      `${annotated.length} cross-source clusters (≥${args.minSources} sources, jaccard ≥ ${args.threshold})\n\n`,
    );
    for (let i = 0; i < annotated.length; i++) {
      const c = annotated[i];
      process.stdout.write(
        `#${i + 1} size=${c.ids.length} sources={${[...c.sources].join(",")}}\n`,
      );
      for (const id of c.ids.slice(0, 8)) {
        const m = meta.get(id);
        process.stdout.write(`    ${id}  ${m?.docType ?? "?"}  ${m?.pluginId ?? "?"}\n`);
      }
      if (c.ids.length > 8) process.stdout.write(`    … +${c.ids.length - 8} more\n`);
    }
    store.close();
  },
});

const runs = defineCommand({
  meta: { name: "runs", description: "List recorded runs." },
  args: { dupesDb: { type: "string", default: defaultDupeDbPath() } },
  run({ args }) {
    const store = new DupeStore(args.dupesDb);
    const rs = store.listRuns();
    for (const r of rs) {
      const elapsed = r.finishedAt ? r.finishedAt - r.startedAt : -1;
      process.stdout.write(
        `${r.runId}  algo=${r.algoVersion}  docs=${r.docsProcessed}  pairs=${r.pairsRecorded}  ${elapsed}s\n`,
      );
    }
    store.close();
  },
});

const main = defineCommand({
  meta: {
    name: "near-dupes-report",
    description: "Inspect signatures, pairs, and clusters in the side DB.",
  },
  subCommands: { stats, clusters, show, sample, "cross-source": crossSource, runs },
});

void runMain(main);
