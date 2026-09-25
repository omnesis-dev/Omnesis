// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `npm run briefs:backtest` — the operator-driven CLI over the
 * mirror-gateway bridge (see `bridge.ts`).
 *
 * The operator picks the snapshot, sources, and window; the bridge
 * refuses non-virtual-clock gateways and the live port outright. This
 * entry is manual-invocation only — never part of `npm run test`, CI,
 * or any hook.
 */

// eslint-disable-next-line no-restricted-imports -- evals tooling reaches into the collector e2e kit; evals/briefs is not a workspace package, so there is no package-name path to it
import { runBridge } from "../../../../packages/collector/src/e2e/briefs-backtest-bridge.js";

const USAGE =
  "usage: briefs:backtest -- --snapshot <omnesis.db copy> --gateway <https://host:17xxx> " +
  "--token <admin token> --t0 <ISO> --until <ISO> [--sources a,b] [--max-docs N] [--dry-run]";

function parseArgs(argv: readonly string[]): {
  snapshot: string;
  gateway: string;
  token: string;
  t0Ms: number;
  untilMs: number;
  sources?: string[];
  maxDocs?: number;
  dryRun: boolean;
} {
  const flags = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (!flag.startsWith("--") || value === undefined) throw new Error(USAGE);
    flags.set(flag.slice(2), value);
    i += 1;
  }
  const need = (name: string): string => {
    const v = flags.get(name);
    if (v === undefined) throw new Error(`--${name} is required (${USAGE})`);
    return v;
  };
  const parseIso = (name: string): number => {
    const ms = Date.parse(need(name));
    if (!Number.isFinite(ms)) throw new Error(`--${name} must be an ISO 8601 instant`);
    return ms;
  };
  const t0Ms = parseIso("t0");
  const untilMs = parseIso("until");
  if (untilMs <= t0Ms) throw new Error("--until must be after --t0");
  const sources = flags.get("sources")?.split(",").filter(Boolean);
  const maxDocsRaw = flags.get("max-docs");
  const maxDocs = maxDocsRaw === undefined ? 5_000 : Number.parseInt(maxDocsRaw, 10);
  if (!Number.isFinite(maxDocs) || maxDocs <= 0) throw new Error("--max-docs must be positive");
  return {
    snapshot: need("snapshot"),
    gateway: need("gateway"),
    token: need("token"),
    t0Ms,
    untilMs,
    ...(sources && sources.length > 0 ? { sources } : {}),
    maxDocs,
    dryRun,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runBridge({
    snapshotPath: args.snapshot,
    gatewayUrl: args.gateway,
    token: args.token,
    t0Ms: args.t0Ms,
    untilMs: args.untilMs,
    ...(args.sources ? { sources: args.sources } : {}),
    ...(args.maxDocs !== undefined ? { maxDocs: args.maxDocs } : {}),
    dryRun: args.dryRun,
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
