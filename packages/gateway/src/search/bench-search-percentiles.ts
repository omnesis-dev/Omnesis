// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Phase-0 search latency percentile bench.
 *
 * Hits POST /search at QPS=1 for `N` samples (default 1000) against the
 * live gateway. Rotates through a pool of diverse queries (the user
 * stipulated "novel queries", so we don't repeat). Captures per-stage
 * timing (BM25, vector, fusion) PLUS the vector stage's embed/sql
 * split, the index.db WAL size before+after each request, and the
 * response status. Writes one JSON file per run to
 * `/tmp/omnesis-percentiles-<label>-<timestamp>.json`.
 *
 * Designed to be invoked with different environment / config layers
 * to produce the seven Phase-0 experiments (E1–E7). The bench script
 * itself is the same; the surrounding orchestration (gateway env vars,
 * collector running, background paused) varies per experiment.
 *
 * Usage:
 *   tsx packages/gateway/src/search/bench-search-percentiles.ts \
 *     --label=E1 --samples=1000
 *
 * Required runtime context (always):
 *   - gateway running, embedder loaded (we wait for first non-skipped
 *     vector stage)
 *   - NODE_EXTRA_CA_CERTS pointed at ~/.config/omnesis/tls/cert.pem
 *   - OMNESIS_TOKEN file readable
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import https from "node:https";

const GATEWAY = process.env.OMNESIS_GATEWAY_URL ?? "https://localhost:7600";
const TOKEN_PATH = process.env.OMNESIS_TOKEN_PATH ?? join(homedir(), ".config/omnesis/token");
const CERT_PATH = process.env.OMNESIS_CERT_PATH ?? join(homedir(), ".config/omnesis/tls/cert.pem");
const INDEX_DB_WAL = (() => {
  const base = process.env.OMNESIS_INDEX_DB_PATH ?? join(homedir(), ".config/omnesis/index.db");
  return `${base}-wal`;
})();

const args = parseArgs(process.argv.slice(2));
const LABEL = args.label ?? "default";
const SAMPLES = Number(args.samples ?? 1000);
const QPS_INTERVAL_MS = Number(args.intervalMs ?? 1000);

const token = readFileSync(TOKEN_PATH, "utf8").trim();
const ca = readFileSync(CERT_PATH);
const agent = new https.Agent({ ca, keepAlive: true });

// 50 diverse query templates. Cover a range of corpus content so no
// single page-cache hot spot dominates.
const QUERIES = [
  "document planning our holiday in the south of france",
  "emails about quarterly business review",
  "notes on home renovation budget",
  "kitchen appliance specifications",
  "messages from the running club",
  "recipes with seasonal vegetables",
  "travel insurance policy details",
  "weekend hiking trail recommendations",
  "tax filing deadline reminders",
  "book recommendations from friends",
  "concerts and live music events",
  "wedding planning checklist tasks",
  "investment portfolio rebalancing notes",
  "garden landscaping ideas spring",
  "vintage wine tasting notes",
  "marathon training schedule weekly",
  "language learning resources japanese",
  "photography composition rules basics",
  "morning meditation routine practice",
  "office furniture ergonomics research",
  "pet care veterinary appointments",
  "online course enrollment confirmations",
  "rental property maintenance receipts",
  "birthday gift ideas family members",
  "scientific paper citation graph",
  "weekly meal planning grocery list",
  "monthly utility bills electricity gas",
  "personal finance budgeting spreadsheet",
  "social media engagement metrics report",
  "podcast episode highlights interesting",
  "musical instrument practice journal",
  "yoga sequence flexibility intermediate",
  "skincare routine product reviews",
  "movie watchlist documentaries",
  "fitness tracker daily steps trends",
  "moving house packing checklist boxes",
  "vehicle service appointment history",
  "homeschool curriculum planning",
  "stargazing constellation guide october",
  "amateur radio frequency log",
  "open source contribution ideas weekend",
  "cooking technique braising stewing",
  "freelance contract template legal",
  "house cleaning supplies inventory",
  "guitar chord progression jazz standards",
  "indoor plant care humidity",
  "personal CRM relationship notes",
  "winter clothing wardrobe rotation",
  "annual goal setting review framework",
  "documentary recommendations climate",
];

interface SampleRow {
  i: number;
  query: string;
  ts: number;
  walBytesBefore: number;
  walBytesAfter: number;
  status: number;
  totalMs: number | null;
  bm25Ms: number | null;
  vectorMs: number | null;
  vectorEmbedMs: number | null;
  vectorSqlMs: number | null;
  fusionMs: number | null;
  boostMs: number | null;
  refCountMs: number | null;
  results: number;
  err?: string;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function walSize(): number {
  try {
    return statSync(INDEX_DB_WAL).size;
  } catch {
    return 0;
  }
}

interface StageReport {
  status?: string;
  durationMs?: number;
  embedMs?: number;
  sqlMs?: number;
}

interface SearchResponseShape {
  results?: unknown[];
  timing?: { totalMs?: number };
  stages?: Record<string, StageReport>;
}

async function postSearch(query: string): Promise<SampleRow> {
  const body = JSON.stringify({ text: query });
  const url = new URL(`${GATEWAY}/search`);
  const walBefore = walSize();
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "content-length": Buffer.byteLength(body).toString(),
        },
        agent,
        // Cap each request at 60 s — even a degenerate stall should not
        // wedge the bench loop for a full N samples.
        timeout: 60_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: SearchResponseShape = {};
          try {
            parsed = JSON.parse(text);
          } catch {
            // keep parsed empty; the row will carry status + raw text
          }
          const stages = parsed.stages ?? {};
          const vec = stages.vector ?? {};
          const walAfter = walSize();
          resolve({
            i: 0,
            query,
            ts: t0,
            walBytesBefore: walBefore,
            walBytesAfter: walAfter,
            status: res.statusCode ?? 0,
            totalMs: parsed.timing?.totalMs ?? null,
            bm25Ms: stages.bm25?.durationMs ?? null,
            vectorMs: vec.durationMs ?? null,
            vectorEmbedMs: vec.embedMs ?? null,
            vectorSqlMs: vec.sqlMs ?? null,
            fusionMs: stages.fusion?.durationMs ?? null,
            boostMs: stages.boost?.durationMs ?? null,
            refCountMs: stages["ref-count"]?.durationMs ?? null,
            results: parsed.results?.length ?? 0,
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({
        i: 0,
        query,
        ts: t0,
        walBytesBefore: walBefore,
        walBytesAfter: walSize(),
        status: 0,
        totalMs: Date.now() - t0,
        bm25Ms: null,
        vectorMs: null,
        vectorEmbedMs: null,
        vectorSqlMs: null,
        fusionMs: null,
        boostMs: null,
        refCountMs: null,
        results: 0,
        err: "timeout 60s",
      });
    });
    req.on("error", (err) => {
      resolve({
        i: 0,
        query,
        ts: t0,
        walBytesBefore: walBefore,
        walBytesAfter: walSize(),
        status: 0,
        totalMs: Date.now() - t0,
        bm25Ms: null,
        vectorMs: null,
        vectorEmbedMs: null,
        vectorSqlMs: null,
        fusionMs: null,
        boostMs: null,
        refCountMs: null,
        results: 0,
        err: err.message,
      });
    });
    req.write(body);
    req.end();
  });
}

function percentiles(xs: number[]): {
  count: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
} {
  if (xs.length === 0) return { count: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  const mean = sorted.reduce((s, x) => s + x, 0) / sorted.length;
  return {
    count: sorted.length,
    p50: pct(0.5),
    p90: pct(0.9),
    p95: pct(0.95),
    p99: pct(0.99),
    max: sorted[sorted.length - 1]!,
    mean,
  };
}

async function main(): Promise<void> {
  console.log(
    `[bench-percentiles] label=${LABEL} samples=${SAMPLES} interval=${QPS_INTERVAL_MS}ms`,
  );
  console.log(`[bench-percentiles] gateway=${GATEWAY} wal=${INDEX_DB_WAL}`);

  // Warm-up: one search to let the snapshot prewarm finish (if needed)
  // and to confirm the embedder is loaded. Discarded.
  const warm = await postSearch(QUERIES[0]!);
  if (warm.status !== 200 || warm.vectorMs == null) {
    console.warn(
      `[bench-percentiles] warm-up unhealthy: status=${warm.status} vec=${warm.vectorMs} err=${warm.err ?? "-"}`,
    );
  } else {
    console.log(
      `[bench-percentiles] warm-up ok: total=${warm.totalMs}ms vec=${warm.vectorMs}ms (embed=${warm.vectorEmbedMs}ms sql=${warm.vectorSqlMs}ms)`,
    );
  }

  const samples: SampleRow[] = [];
  const start = Date.now();
  for (let i = 0; i < SAMPLES; i++) {
    const q = QUERIES[i % QUERIES.length]!;
    const t = Date.now();
    const row = await postSearch(q);
    row.i = i;
    samples.push(row);
    if ((i + 1) % 50 === 0) {
      const recent = samples.slice(Math.max(0, samples.length - 50));
      const recentTot = recent.map((r) => r.totalMs).filter((x): x is number => x != null);
      const p50 = percentiles(recentTot).p50;
      const p99 = percentiles(recentTot).p99;
      const maxRecent = Math.max(...recentTot, 0);
      console.log(
        `[bench-percentiles] ${i + 1}/${SAMPLES}  recent-50: p50=${p50.toFixed(0)}ms p99=${p99.toFixed(0)}ms max=${maxRecent.toFixed(0)}ms`,
      );
    }
    const elapsed = Date.now() - t;
    if (elapsed < QPS_INTERVAL_MS) {
      await sleep(QPS_INTERVAL_MS - elapsed);
    }
  }
  const elapsedTotal = Date.now() - start;

  const tot = samples.map((r) => r.totalMs).filter((x): x is number => x != null);
  const vec = samples.map((r) => r.vectorMs).filter((x): x is number => x != null);
  const emb = samples.map((r) => r.vectorEmbedMs).filter((x): x is number => x != null);
  const sql = samples.map((r) => r.vectorSqlMs).filter((x): x is number => x != null);
  const bm = samples.map((r) => r.bm25Ms).filter((x): x is number => x != null);

  const summary = {
    label: LABEL,
    samples: samples.length,
    intervalMs: QPS_INTERVAL_MS,
    elapsedMs: elapsedTotal,
    pTotal: percentiles(tot),
    pVector: percentiles(vec),
    pVectorEmbed: percentiles(emb),
    pVectorSql: percentiles(sql),
    pBm25: percentiles(bm),
    walBytesStart: samples[0]?.walBytesBefore ?? null,
    walBytesEnd: samples[samples.length - 1]?.walBytesAfter ?? null,
    errors: samples.filter((s) => s.err != null).length,
  };

  console.log("\n[bench-percentiles] summary:");
  console.log(JSON.stringify(summary, null, 2));

  const outPath = `/tmp/omnesis-percentiles-${LABEL}-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify({ summary, samples }, null, 2));
  console.log(`\n[bench-percentiles] wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
