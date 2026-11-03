// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis stalls` — what has been blocking the gateway's event loop.
 *
 * Prints `GET /admin/stalls`: stalls over a window ranked by the activity
 * that caused them, the newest few one by one, and the CPU profiles the
 * gateway's flight recorder captured when stalls recurred.
 */

import { defineCommand } from "citty";
import {
  c,
  gw,
  isJSON,
  withSpinner,
  CliError,
  EXIT_GATEWAY_ERROR,
  pickGatewayExitCode,
} from "../utils.js";

interface Frame {
  functionName: string;
  file: string;
  line: number | null;
}

/** The slice of `GET /admin/stalls` this command prints. */
export interface StallsResponse {
  enabled: boolean;
  thresholdMs: number;
  windowMinutes: number;
  minMs: number;
  summary: { count: number; totalMs: number; maxMs: number };
  ranking: Array<{
    culprit: string | null;
    count: number;
    totalMs: number;
    maxMs: number;
    lastSeenAt: string;
  }>;
  recent: Array<{
    startedAt: string;
    durationMs: number;
    activity: string | null;
    outer: string | null;
    inFlight: string[];
    attribution: "running" | "in-flight" | "code" | "none";
    culprit: string | null;
    code: Frame | null;
    /** Where the snapshot behind `code` was taken; absent from older gateways. */
    codeActivity?: string | null;
  }>;
  capturing: string | null;
  profiles: Array<{
    id: string;
    capturedAt: string;
    reason: string;
    longRunMs: number;
    hottestCode: Frame | null;
    topStacks: Array<{ selfMs: number; frames: Frame[] }>;
  }>;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const clock = (iso: string): string => new Date(iso).toLocaleString();
const where = (f: Frame): string =>
  `${f.functionName}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`;

export function renderStalls(r: StallsResponse): string {
  const out: string[] = [];
  if (!r.enabled) {
    out.push(
      `${c.yellow}This gateway is not recording stalls: detection is off (gateway.stalls.enabled) or its watchdog stopped; the gateway log says which.${c.reset}`,
    );
  }
  const floor = Math.max(r.minMs, r.thresholdMs);
  out.push(
    `${c.bold}Event-loop stalls of ${floor}ms or more, last ${r.windowMinutes} minutes${c.reset}`,
  );
  if (r.summary.count === 0) {
    out.push(`  ${c.dim}None.${c.reset}`);
  } else {
    out.push(
      `  ${r.summary.count} stalls, ${seconds(r.summary.totalMs)} blocked, worst ${seconds(r.summary.maxMs)}`,
      "",
    );
    for (const g of r.ranking) {
      const name = g.culprit ?? `${c.dim}(not attributed)${c.reset}`;
      out.push(
        `  ${seconds(g.totalMs).padStart(8)}  ${String(g.count).padStart(4)}×  worst ${seconds(g.maxMs).padStart(7)}  ${name}`,
      );
    }
  }
  if (r.recent.length > 0) {
    out.push("", `${c.bold}Most recent${c.reset}`);
    for (const s of r.recent) {
      let what: string;
      const sampledIn =
        s.codeActivity !== undefined && s.codeActivity !== s.activity
          ? ` ${c.dim}(sampled ${s.codeActivity ? `in ${s.codeActivity}` : "outside any marked activity"})${c.reset}`
          : "";
      const at = s.code ? ` ${c.dim}at${c.reset} ${where(s.code)}${sampledIn}` : "";
      if (s.attribution === "running") {
        what = `${s.activity}${s.outer && s.outer !== s.activity ? ` ${c.dim}(in ${s.outer})${c.reset}` : ""}${at}`;
      } else if (s.attribution === "in-flight") {
        what = `${s.culprit} ${c.dim}(in flight)${c.reset}${at}`;
      } else if (s.attribution === "code") {
        what = `${where(s.code!)}${sampledIn}${s.inFlight.length > 0 ? ` ${c.dim}(in flight: ${s.inFlight.join(", ")})${c.reset}` : ""}`;
      } else {
        what = `${c.dim}not attributed${s.inFlight.length > 0 ? `; in flight: ${s.inFlight.join(", ")}` : ""}${c.reset}`;
      }
      out.push(`  ${clock(s.startedAt)}  ${seconds(s.durationMs).padStart(7)}  ${what}`);
    }
  }
  out.push("", `${c.bold}CPU profiles captured when stalls recurred${c.reset}`);
  if (r.capturing) out.push(`  ${c.cyan}Capturing ${r.capturing} now.${c.reset}`);
  if (r.profiles.length === 0 && !r.capturing) out.push(`  ${c.dim}None kept.${c.reset}`);
  for (const p of r.profiles) {
    out.push(
      `  ${c.cyan}${p.id}${c.reset}  ${clock(p.capturedAt)}  ${c.dim}${p.reason}${c.reset}`,
      `    ${seconds(p.longRunMs)} in long busy runs; hottest code: ${p.hottestCode ? where(p.hottestCode) : "none named"}`,
    );
    const stack = p.topStacks[0];
    if (stack) {
      out.push(`    hottest stack (${seconds(stack.selfMs)}):`);
      for (const f of stack.frames.slice(0, 8)) out.push(`      ${c.dim}at${c.reset} ${where(f)}`);
    }
  }
  return out.join("\n");
}

export const stallsCommand = defineCommand({
  meta: {
    name: "stalls",
    description: "Rank what has been blocking the gateway's event loop",
  },
  args: {
    window: {
      type: "string",
      description: "Minutes to look back (default 60, at most 1440)",
    },
    min: {
      type: "string",
      description: "Leave out stalls shorter than this many milliseconds",
    },
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
    },
  },
  async run({ args }) {
    const query = new URLSearchParams({ limit: "10" });
    if (args.window) query.set("windowMinutes", args.window);
    if (args.min) query.set("minMs", args.min);
    const res = await withSpinner("Reading stalls", () => gw(`/admin/stalls?${query}`));
    if (res.status === 404) {
      throw new CliError(
        `${c.yellow}This gateway does not record stalls; update it to a version that does.${c.reset}`,
        EXIT_GATEWAY_ERROR,
      );
    }
    if (!res.ok) {
      throw new CliError(
        `${c.red}Failed to read stalls: ${res.status} ${await res.text()}${c.reset}`,
        pickGatewayExitCode(res.status),
      );
    }
    const report = (await res.json()) as StallsResponse;
    console.log(isJSON ? JSON.stringify(report, null, 2) : renderStalls(report));
  },
});
