// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Phase-2 matrix: snapshot off vs ON, both with bg=running and the
 * collector live so the indexer worker is actively writing to index.db.
 * That's the regime that originally produced the 7.6s vector-stage SQL
 * stalls in the journey doc — phase 1 didn't reproduce it because
 * collector was stopped.
 *
 * 5 sample points (T=0/60/120/180/240) × 3 samples each. Sample 0 uses
 * query A, samples 1+2 reuse query A so we measure repeated-query
 * latency under live indexer write pressure. That's the case where
 * snapshot isolation should keep the SQLite page cache warm.
 *
 * Usage:
 *   npx tsx packages/gateway/src/search/matrix-snapshot-live-phase2.ts
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
const START_CMD = process.env.GATEWAY_START_CMD ?? "/tmp/start-gateway.sh";
const SAMPLE_TIMES = (process.env.SAMPLE_TIMES ?? "0,60,120,180,240")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));
const SAMPLES_PER_POINT = Number(process.env.SAMPLES_PER_POINT ?? "3");
const QUERY_A = "document planning our holiday in the south of france";

const token = readFileSync(TOKEN_PATH, "utf8").trim();
const ca = readFileSync(CERT_PATH);
const agent = new https.Agent({ ca, keepAlive: true });

interface Sample {
  totalMs: number;
  vectorMs: number | null;
  bm25Ms: number | null;
  status: number;
}

interface PointResult {
  combo: string;
  snapshotEnabled: boolean;
  tSeconds: number;
  samples: Sample[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
            stages?: Record<string, { durationMs?: number }>;
          };
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = {};
          }
          resolve({
            totalMs: parsed.timing?.totalMs ?? 0,
            vectorMs: parsed.stages?.vector?.durationMs ?? null,
            bm25Ms: parsed.stages?.bm25?.durationMs ?? null,
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

async function gatewayReachable(timeoutMs = 120_000): Promise<boolean> {
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

async function waitForEmbedder(timeoutMs = 180_000): Promise<boolean> {
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

async function restartGateway(): Promise<void> {
  console.log(`[matrix] restarting gateway in tmux pane ${PANE}`);
  execSync(`tmux send-keys -t ${PANE} C-c`, { stdio: "inherit" });
  await sleep(8000);
  // clear scrollback so waitForEmbedder doesn't trip on old "embedder attached"
  execSync(`tmux clear-history -t ${PANE}`, { stdio: "inherit" });
  execSync(`tmux send-keys -t ${PANE} clear Enter`, { stdio: "inherit" });
  await sleep(500);
  execSync(`tmux send-keys -t ${PANE} "${START_CMD}" Enter`, {
    stdio: "inherit",
  });
  const reachable = await gatewayReachable(120_000);
  if (!reachable) throw new Error("gateway did not become reachable in 120s");
  console.log(`[matrix] gateway reachable, waiting for embedder…`);
  if (!(await waitForEmbedder(180_000))) {
    throw new Error("embedder did not attach within 180s");
  }
  await sleep(2000);
  console.log(`[matrix] gateway up + embedder ready`);
}

function summarize(samples: Sample[]): string {
  const vec = samples.map((s) => s.vectorMs).filter((x): x is number => x != null);
  const tot = samples.map((s) => s.totalMs);
  const fmt = (xs: number[]) =>
    xs.length === 0
      ? "—"
      : `${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(0)}ms ` +
        `(${xs.map((x) => x.toFixed(0)).join(", ")})`;
  return `vec=${fmt(vec)}  total=${fmt(tot)}`;
}

async function runCombo(snapshotEnabled: boolean): Promise<PointResult[]> {
  const combo = `snapshot=${snapshotEnabled ? "ON" : "off"} bg=running collector=running`;
  console.log(`\n========== ${combo} ==========`);
  setSnapshotInConfig(snapshotEnabled);
  await restartGateway();

  const t0 = Date.now();
  const results: PointResult[] = [];
  for (const tSec of SAMPLE_TIMES) {
    const targetMs = t0 + tSec * 1000;
    const now = Date.now();
    if (now < targetMs) await sleep(targetMs - now);

    const samples: Sample[] = [];
    for (let i = 0; i < SAMPLES_PER_POINT; i++) {
      const s = await postSearch(QUERY_A);
      samples.push(s);
      await sleep(300);
    }
    console.log(`[matrix] T=${tSec}s  ${summarize(samples)}`);
    results.push({ combo, snapshotEnabled, tSeconds: tSec, samples });
  }
  return results;
}

async function main(): Promise<void> {
  const matrix: boolean[] = [false, true]; // snap off, snap ON

  const originalConfig = readFileSync(CONFIG_PATH, "utf8");
  const all: PointResult[] = [];
  try {
    for (const snap of matrix) {
      const r = await runCombo(snap);
      all.push(...r);
    }
  } finally {
    console.log("\n[matrix] restoring original config + restart");
    writeFileSync(CONFIG_PATH, originalConfig);
    try {
      execSync(`tmux send-keys -t ${PANE} C-c`, { stdio: "inherit" });
      await sleep(6000);
      execSync(`tmux clear-history -t ${PANE}`, { stdio: "inherit" });
      execSync(`tmux send-keys -t ${PANE} clear Enter`, { stdio: "inherit" });
      await sleep(500);
      execSync(`tmux send-keys -t ${PANE} "${START_CMD}" Enter`, {
        stdio: "inherit",
      });
      await gatewayReachable(60_000);
    } catch (e) {
      console.warn(`[matrix] restore-restart failed: ${(e as Error).message}`);
    }
  }

  console.log("\n\n================ PHASE 2 REPORT ================\n");
  for (const r of all) {
    console.log(`${r.combo}  T=${r.tSeconds}s  ${summarize(r.samples)}`);
  }

  const outPath = `/tmp/omnesis-matrix-phase2-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify({ matrix: all }, null, 2));
  console.log(`\n[matrix] wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
