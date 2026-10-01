// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { buildResultUrl, linkify } from "../utils.js";
import type { buildCliFx } from "../utils.js";
import type { ToolResult } from "@omnesis/core";

export type AgentSearchResult = Extract<ToolResult, { kind: "search.results" }>;

/** Preserve the ordinary search request and only negotiate an absent debug route. */
export async function requestSearch(
  query: string,
  limit: number,
  agentContext: boolean,
  request: (path: string, init: RequestInit) => Promise<Response>,
  notice: (message: string) => void,
): Promise<{ response: Response; agentContext: boolean }> {
  const init = { method: "POST", body: JSON.stringify({ text: query, limit }) };
  const response = await request(agentContext ? "/admin/search/agent-context" : "/search", init);
  if (agentContext && (response.status === 404 || response.status === 405)) {
    notice(
      "Agent context search is unavailable or disabled on this gateway; using ordinary search.",
    );
    return { response: await request("/search", init), agentContext: false };
  }
  return { response, agentContext };
}

/** Third-party text must not inject terminal controls into plain output. */
function terminalText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

export function renderAgentSearch(
  result: AgentSearchResult,
  verbose: boolean,
  fx: Awaited<ReturnType<typeof buildCliFx>>,
): string[] {
  const lines: string[] = [];
  const clean = terminalText;
  if (verbose) {
    lines.push("── Agent Context ──", `Query: "${clean(result.query)}"`);
    lines.push(`Timing: ${result.durationMs}ms`);
    if (result.candidates !== undefined) lines.push(`Candidates: ${result.candidates}`);
    lines.push("");
  }
  if (!result.results.length) {
    lines.push(`No results found for "${clean(result.query)}"`);
    return lines;
  }
  for (const [index, hit] of result.results.entries()) {
    const title = clean(hit.title ?? hit.documentId);
    const url = clean(hit.url ?? hit.appUrl ?? buildResultUrl(hit.documentId));
    lines.push(`${index + 1}. ${linkify(title, url, fx)}`);
    lines.push(`   ${clean(hit.documentId)}  ${clean(hit.sourceId)}`);
    if (hit.snippet) lines.push(`   ${clean(hit.snippet).slice(0, 200)}`);
    if (hit.url) lines.push(`   ${linkify(clean(hit.url), clean(hit.url), fx)}`);
    if (hit.appUrl) lines.push(`   ${linkify(clean(hit.appUrl), clean(hit.appUrl), fx)}`);
    if (hit.provenance) {
      lines.push(`   ${clean(hit.provenance.summary)}`);
      for (const copy of hit.provenance.copies) {
        const details = [copy.documentId, copy.sourceId, copy.title, copy.deviceName, copy.path]
          .filter((value): value is string => value !== undefined)
          .map(clean);
        lines.push(`   Copy: ${details.join(" | ")}`);
        for (const sourceUrl of [copy.url, copy.appUrl])
          if (sourceUrl) lines.push(`     ${linkify(clean(sourceUrl), clean(sourceUrl), fx)}`);
      }
      for (const path of hit.provenance.paths) {
        let trail = clean(path.documentIds[0]!);
        for (const [step, edge] of path.edges.entries()) {
          const label = clean(edge.replace(/^(?:inbound|outbound):/, ""));
          const connection = edge.startsWith("inbound:")
            ? `<--[${label}]--`
            : edge.startsWith("outbound:")
              ? `--[${label}]-->`
              : `--[${label}]--`;
          trail += ` ${connection} ${clean(path.documentIds[step + 1]!)}`;
        }
        lines.push(`   Trail: ${trail}`);
      }
      if (hit.provenance.truncated)
        lines.push(`   Context truncated: ${hit.provenance.stopReasons.map(clean).join(", ")}`);
    } else {
      for (const crumb of hit.breadcrumb ?? [])
        lines.push(
          `   Related (${clean(crumb.edge)}): ${clean(crumb.title ?? crumb.documentId)} | ${clean(crumb.documentId)}`,
        );
    }
    if (index < result.results.length - 1) lines.push("");
  }
  if (!verbose) lines.push("", `${result.results.length} results in ${result.durationMs}ms`);
  return lines;
}
