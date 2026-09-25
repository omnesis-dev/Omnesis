// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  isJSON,
  gatewayFetch,
  withSpinner,
  CliError,
  EXIT_AUTH,
  EXIT_USER_ERROR,
  EXIT_GATEWAY_ERROR,
  EXIT_FAILURE,
} from "../utils.js";

/** Subset of the gateway `DocumentGraph` we render. */
interface Vertex {
  id: string;
  kind: string;
  title?: string;
  canonicalName?: string;
  tableName?: string;
}
interface Edge {
  from: string;
  to: string;
  type: string;
  directed: boolean;
  jaccard?: number;
}
interface GraphResult {
  seeds: string[];
  vertices: Vertex[];
  edges: Edge[];
  truncated: boolean;
  stats: { visited: number; fanoutCapHits: number; maxDepthReached: number; elapsedMs: number };
}

function splitList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

function intArg(raw: string | undefined, name: string, lo: number, hi: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < lo || n > hi) {
    throw new CliError(
      `${c.red}--${name} must be an integer between ${lo} and ${hi}${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  return n;
}

function vertexLabel(v: Vertex | undefined): string {
  if (!v) return "?";
  if (v.kind === "person") return v.canonicalName ?? v.id;
  if (v.kind === "analytics-row") return `row:${v.tableName ?? "?"}`;
  return v.title ?? v.id;
}

/** The subset of parsed CLI args `buildWalkBody` reads. */
export interface GraphWalkArgs {
  start?: string;
  edges?: string;
  "vertex-types"?: string;
  hops?: string;
  "max-results"?: string;
  "fanout-cap"?: string;
  provenance?: string;
  "min-score"?: string;
  "bound-rows"?: boolean;
}

/**
 * Compose the `POST /graph/walk` request body from parsed CLI args, validating
 * numeric ranges. Pure (no I/O) so the filter composition + validation is
 * unit-testable without a gateway. Throws `CliError(EXIT_USER_ERROR)` on a bad
 * positional or out-of-range flag.
 */
export function buildWalkBody(args: GraphWalkArgs): {
  start: { kind: string; id: string }[];
  edgeTypes?: string[];
  vertexTypes?: string[];
  maxHops?: number;
  maxResults?: number;
  fanoutCap?: number;
  provenanceKinds?: string[];
  minScore?: number;
  includeBoundRows: boolean;
} {
  const start = args.start;
  if (!start) {
    throw new CliError(
      `${c.red}Usage: omnesis graph walk <start-id> [--edges ...] [--hops N] [--provenance ...]${c.reset}`,
      EXIT_USER_ERROR,
    );
  }

  let minScore: number | undefined;
  if (args["min-score"] !== undefined) {
    const f = Number.parseFloat(args["min-score"]);
    if (Number.isNaN(f) || f < 0 || f > 1) {
      throw new CliError(`${c.red}--min-score must be between 0 and 1${c.reset}`, EXIT_USER_ERROR);
    }
    minScore = f;
  }

  return {
    start: [{ kind: "document", id: start }],
    edgeTypes: splitList(args.edges),
    vertexTypes: splitList(args["vertex-types"]),
    maxHops: intArg(args.hops, "hops", 1, 15),
    maxResults: intArg(args["max-results"], "max-results", 10, 2000),
    fanoutCap: intArg(args["fanout-cap"], "fanout-cap", 1, 500),
    provenanceKinds: splitList(args.provenance),
    minScore,
    includeBoundRows: args["bound-rows"] === true,
  };
}

const graphWalkCommand = defineCommand({
  meta: {
    name: "walk",
    description: "Walk the knowledge graph from a seed document",
  },
  args: {
    start: {
      type: "positional",
      description: "seed document ID (or unambiguous prefix)",
      required: true,
    },
    edges: { type: "string", description: "Only traverse these edge types (comma-separated)" },
    "vertex-types": {
      type: "string",
      description: "Only include these vertex kinds (document,person,analytics-row)",
    },
    hops: { type: "string", description: "Max hops (1-15, default 10)" },
    "max-results": { type: "string", description: "Max vertices (10-2000, default 600)" },
    "fanout-cap": { type: "string", description: "Per-category fanout cap (1-500, default 50)" },
    provenance: {
      type: "string",
      description: "Only these provenance kinds (source-declared,content-derived,...)",
    },
    "min-score": { type: "string", description: "Minimum near-duplicate jaccard (0-1)" },
    "bound-rows": { type: "boolean", description: "Attach cross-store analytics-row vertices" },
    json: { type: "boolean", description: "Machine-readable JSON output" },
  },
  async run(ctx) {
    const { args } = ctx;
    const body = buildWalkBody(args);
    const start = body.start[0].id;

    const res = await withSpinner(`Walking from ${start.slice(0, 8)}`, () =>
      gatewayFetch("/graph/walk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const data = (await res.json()) as GraphResult | { error?: string; matches?: string[] };

    if (!res.ok) {
      const err = data as { error?: string; matches?: string[] };
      if (err.matches) {
        throw new CliError(
          `${c.red}Ambiguous ID prefix. Matches: ${err.matches.join(", ")}${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      const code =
        res.status === 401 || res.status === 403
          ? EXIT_AUTH
          : res.status === 404
            ? EXIT_USER_ERROR
            : res.status >= 500
              ? EXIT_GATEWAY_ERROR
              : EXIT_FAILURE;
      throw new CliError(
        `${c.red}${String(err.error ?? `Request returned ${res.status}`)}${c.reset}`,
        code,
      );
    }

    const graph = data as GraphResult;

    if (isJSON) {
      console.log(JSON.stringify(graph, null, 2));
      return;
    }

    const byId = new Map(graph.vertices.map((v) => [v.id, v] as const));
    const seedLabels = graph.seeds.map((s) => vertexLabel(byId.get(s))).join(", ");
    console.log(`\n${c.bold}Graph walk${c.reset}  ${c.dim}from: ${seedLabels}${c.reset}`);
    if (graph.truncated) {
      console.log(
        `${c.yellow}  (truncated — raise --hops / --max-results / --fanout-cap)${c.reset}`,
      );
    }
    console.log();

    for (const e of graph.edges) {
      const arrow = e.directed ? "→" : "↔";
      const score = e.jaccard !== undefined ? ` ${c.dim}(${e.jaccard.toFixed(2)})${c.reset}` : "";
      console.log(
        `  ${vertexLabel(byId.get(e.from))} ${arrow} ${c.bold}${e.type}${c.reset} ${arrow} ${vertexLabel(byId.get(e.to))}${score}`,
      );
    }

    const kinds = new Map<string, number>();
    for (const v of graph.vertices) kinds.set(v.kind, (kinds.get(v.kind) ?? 0) + 1);
    const kindSummary = [...kinds].map(([k, n]) => `${n} ${k}`).join(", ");
    console.log(
      `\n${c.dim}${graph.vertices.length} vertices (${kindSummary})  ·  ${graph.edges.length} edges  ·  depth ${graph.stats.maxDepthReached}  ·  ${graph.stats.elapsedMs}ms${c.reset}`,
    );
  },
});

export const graphCommand = defineCommand({
  meta: { name: "graph", description: "Traverse the knowledge graph" },
  subCommands: {
    walk: graphWalkCommand,
  },
});
