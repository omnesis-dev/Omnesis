// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Live-system matrix runner: searches over the 2×2 (snapshot enabled?
 * × background paused?) cross product on a real Omnesis gateway,
 * sampling search latency at T=0/60/120/180/240 seconds after
 * gateway restart.
 *
 * The runner manages gateway lifecycle by sending keystrokes to the
 * tmux pane the gateway is running in (default: 0:1.1). The collector
 * pane is left alone — the test assumes it has been stopped manually
 * for a clean read on cache-eviction effects.
 *
 * Final report is a markdown-ish table dumped to stdout + saved to
 * /tmp/omnesis-matrix-snapshot-<timestamp>.json so it can be eyeballed
 * later.
 *
 * Usage:
 *   npx tsx packages/gateway/src/search/matrix-snapshot-live.ts
 *
 * Optional env:
 *   OMNESIS_GATEWAY_URL (default https://localhost:7600)
 *   OMNESIS_TOKEN_PATH  (default ~/.config/omnesis/token)
 *   OMNESIS_CERT_PATH   (default ~/.config/omnesis/tls/cert.pem)
 *   GATEWAY_TMUX_PANE   (default 0:1.1)
 *   SAMPLE_TIMES        (default "0,60,120,180,240" — seconds since ready)
 *   SAMPLES_PER_POINT   (default 2)
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import https from "node:https";

const GATEWAY = process.env.OMNESIS_GATEWAY_URL ?? "https://localhost:7600";
const TOKEN_PATH = process.env.OMNESIS_TOKEN_PATH ?? join(homedir(), ".config/omnesis/token");
const CERT_PATH = process.env.OMNESIS_CERT_PATH ?? join(homedir(), ".config/omnesis/tls/cert.pem");
const CONFIG_PATH = join(homedir(), ".config/omnesis/omnesis.json");
const PANE = process.env.GATEWAY_TMUX_PANE ?? "0:1.1";
const SAMPLE_TIMES = (process.env.SAMPLE_TIMES ?? "0,60,120,180,240")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));
const SAMPLES_PER_POINT = Number(process.env.SAMPLES_PER_POINT ?? "2");
const QUERIES = [
  "document planning our holiday in the south of france",
  "notes on home renovation budget",
];

const token = readFileSync(TOKEN_PATH, "utf8").trim();
const ca = readFileSync(CERT_PATH);
const agent = new https.Agent({ ca, keepAlive: true });

interface Sample {
  totalMs: number;
  vectorMs: number | null;
  vectorSqlMs: number | null;
  embedMs: number | null;
  bm25Ms: number | null;
  query: string;
  status: number;
}

interface PointResult {
  combo: string;
  snapshotEnabled: boolean;
  backgroundPaused: boolean;
  tSeconds: number;
  samples: Sample[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tmux(cmd: string[]): void {
  execSync(["tmux", ...cmd].join(" "), { stdio: "inherit" });
}

function tmuxSendKeys(pane: string, keys: string): void {
  execSync(
    `tmux send-keys -t ${pane} ${keys
      .split(" ")
      .map((k) => k)
      .join(" ")}`,
    { stdio: "inherit" },
  );
}

async function postSearch(query: string): Promise<Sample> {
  const body = JSON.stringify({ text: query });
  const url = new URL(`${GATEWAY}/search`);
  return new Promise((resolve, reject) => {
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
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: {
            timing?: { totalMs?: number };
            stages?: Record<string, { durationMs?: number; details?: Record<string, unknown> }>;
          };
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = {};
          }
          const totalMs = parsed.timing?.totalMs ?? 0;
          const vecStage = parsed.stages?.vector ?? null;
          const bm25Stage = parsed.stages?.bm25 ?? null;
          const vectorMs = vecStage?.durationMs ?? null;
          const embedMs = (vecStage?.details as { embedMs?: number } | undefined)?.embedMs ?? null;
          const vectorSqlMs = (vecStage?.details as { sqlMs?: number } | undefined)?.sqlMs ?? null;
          const bm25Ms = bm25Stage?.durationMs ?? null;
          resolve({
            totalMs,
            vectorMs,
            vectorSqlMs,
            embedMs,
            bm25Ms,
            query,
            status: res.statusCode ?? 0,
          });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function gatewayReachable(timeoutMs = 60_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const req = https.request(
          {
            method: "GET",
            hostname: new URL(GATEWAY).hostname,
            port: new URL(GATEWAY).port || 443,
            path: "/admin/background/status",
            headers: { authorization: `Bearer ${token}` },
            agent,
            timeout: 2000,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve(res.statusCode === 200));
          },
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      });
      if (ok) return true;
    } catch {
      // retry
    }
    await sleep(500);
  }
  return false;
}

async function setBackgroundPaused(paused: boolean): Promise<void> {
  const path = paused ? "/admin/background/pause" : "/admin/background/resume";
  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        method: "POST",
        hostname: new URL(GATEWAY).hostname,
        port: new URL(GATEWAY).port || 443,
        path,
        headers: { authorization: `Bearer ${token}` },
        agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          res.statusCode === 200
            ? resolve()
            : reject(
                new Error(
                  `${path} returned ${res.statusCode}: ${Buffer.concat(chunks).toString()}`,
                ),
              ),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function setSnapshotInConfig(enabled: boolean): void {
  const raw = readFileSync(CONFIG_PATH, "utf8");
  const cfg = JSON.parse(raw) as Record<string, unknown>;
  const search = (cfg.search as Record<string, unknown> | undefined) ?? {};
  if (enabled) {
    search.snapshot = { enabled: true, refreshIntervalMs: 600000 };
  } else {
    delete search.snapshot;
  }
  cfg.search = search;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`[matrix] omnesis.json: search.snapshot.enabled = ${enabled}`);
}

async function waitForEmbedder(timeoutMs = 120_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const out = execSync(`tmux capture-pane -t ${PANE} -p -S -800`).toString();
      if (out.includes("embedder attached")) return true;
    } catch {
      // ignore
    }
    await sleep(2000);
  }
  return false;
}

const START_CMD = process.env.GATEWAY_START_CMD ?? "/tmp/start-gateway.sh";

async function restartGateway(): Promise<void> {
  console.log(`[matrix] restarting gateway in tmux pane ${PANE}`);
  // Ctrl-C the running gateway. send-keys uses C-c for control-c.
  execSync(`tmux send-keys -t ${PANE} C-c`, { stdio: "inherit" });
  // Give it time to fully shut down (prewarm-in-flight + scheduler dispose
  // can take ~20s if it Ctrl-C lands mid-warm).
  await sleep(8000);
  // Clear scrollback so waitForEmbedder doesn't trip on the previous
  // session's "embedder attached" line — the bug that produced a
  // matrix run with vec=— on every paused / snapshot combo.
  execSync(`tmux clear-history -t ${PANE}`, { stdio: "inherit" });
  execSync(`tmux send-keys -t ${PANE} clear Enter`, { stdio: "inherit" });
  await sleep(500);
  // Start fresh — use the system start script so cwd is correct.
  execSync(`tmux send-keys -t ${PANE} "${START_CMD}" Enter`, {
    stdio: "inherit",
  });
  console.log(`[matrix] waiting for gateway readiness…`);
  const reachable = await gatewayReachable(120_000);
  if (!reachable) throw new Error("gateway did not become reachable in 120s");
  console.log(`[matrix] gateway reachable, waiting for embedder…`);
  const embedderReady = await waitForEmbedder(180_000);
  if (!embedderReady) {
    throw new Error("embedder did not attach within 180s");
  }
  // small extra settle so any race between embedder attach + worker
  // ready resolves
  await sleep(2000);
  console.log(`[matrix] gateway up + embedder ready`);
}

function summarizeSamples(samples: Sample[]): string {
  if (samples.length === 0) return "(no samples)";
  const vec = samples.map((s) => s.vectorMs).filter((x): x is number => x != null);
  const sql = samples.map((s) => s.vectorSqlMs).filter((x): x is number => x != null);
  const tot = samples.map((s) => s.totalMs).filter((x): x is number => x != null);
  const fmt = (xs: number[]) =>
    xs.length === 0
      ? "—"
      : `${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(0)}ms ` +
        `(${xs.map((x) => x.toFixed(0)).join(", ")})`;
  return `vec=${fmt(vec)}  sql=${fmt(sql)}  total=${fmt(tot)}`;
}

async function runCombo(
  snapshotEnabled: boolean,
  backgroundPaused: boolean,
): Promise<PointResult[]> {
  const combo = `snapshot=${snapshotEnabled ? "ON" : "off"} bg=${backgroundPaused ? "paused" : "running"}`;
  console.log(`\n========== Combo: ${combo} ==========`);

  setSnapshotInConfig(snapshotEnabled);
  await restartGateway();

  if (backgroundPaused) {
    await setBackgroundPaused(true);
    console.log(`[matrix] background paused`);
  }

  const t0 = Date.now();
  const results: PointResult[] = [];
  for (const tSec of SAMPLE_TIMES) {
    const targetMs = t0 + tSec * 1000;
    const now = Date.now();
    if (now < targetMs) {
      const wait = targetMs - now;
      console.log(`[matrix] T=${tSec}s — waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
    const samples: Sample[] = [];
    for (let i = 0; i < SAMPLES_PER_POINT; i++) {
      const q = QUERIES[i % QUERIES.length] ?? QUERIES[0]!;
      const s = await postSearch(q);
      samples.push(s);
      // small inter-sample gap so they don't fully overlap on the JS thread
      await sleep(200);
    }
    console.log(`[matrix] T=${tSec}s  ${summarizeSamples(samples)}`);
    results.push({
      combo,
      snapshotEnabled,
      backgroundPaused,
      tSeconds: tSec,
      samples,
    });
  }

  if (backgroundPaused) {
    await setBackgroundPaused(false);
    console.log(`[matrix] background resumed`);
  }

  return results;
}

async function main(): Promise<void> {
  const matrix: Array<[boolean, boolean]> = [
    [false, false], // baseline
    [false, true], // bench-equivalent (paused, no snapshot)
    [true, false], // snapshot on, normal load
    [true, true], // snapshot on, paused (sanity)
  ];

  const all: PointResult[] = [];
  const originalConfig = readFileSync(CONFIG_PATH, "utf8");
  try {
    for (const [snap, paused] of matrix) {
      const r = await runCombo(snap, paused);
      all.push(...r);
    }
  } finally {
    // Restore original config + restart gateway.
    console.log("\n[matrix] restoring original config + restart");
    writeFileSync(CONFIG_PATH, originalConfig);
    try {
      execSync(`tmux send-keys -t ${PANE} C-c`, { stdio: "inherit" });
      await sleep(4000);
      execSync(`tmux send-keys -t ${PANE} "npm run gateway" Enter`, {
        stdio: "inherit",
      });
      await gatewayReachable(60_000);
    } catch (e) {
      console.warn(`[matrix] restore-restart failed: ${(e as Error).message}`);
    }
  }

  // Report
  console.log("\n\n================ MATRIX REPORT ================\n");
  for (const r of all) {
    console.log(`${r.combo}  T=${r.tSeconds}s  ${summarizeSamples(r.samples)}`);
  }

  const outPath = `/tmp/omnesis-matrix-snapshot-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify({ matrix: all }, null, 2));
  console.log(`\n[matrix] wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
