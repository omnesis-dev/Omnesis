// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  isJSON,
  gw,
  withSpinner,
  CliError,
  EXIT_AUTH,
  EXIT_USER_ERROR,
  EXIT_GATEWAY_ERROR,
  EXIT_FAILURE,
} from "../utils.js";

/** Wire shape of `GET /documents/:id/edges` (gateway `DocumentEdgesView`). */
interface DocumentEdge {
  direction: "outbound" | "inbound";
  linkType: string;
  otherDocId: string | null;
  otherTitle: string | null;
  otherSourceId: string | null;
  resolved: boolean;
  provenanceKind: string | null;
  provenanceOrigin: string | null;
  provenanceVersion: string | null;
  declaredAt: string | null;
  metadataJson: string | null;
}
interface PendingEdgeView {
  linkType: string;
  targetSourceId: string;
  targetExternalId: string;
  provenanceOrigin: string;
  declaredAt: string;
  attemptCount: number;
}
interface DocumentEdgesView {
  edges: DocumentEdge[];
  pending: PendingEdgeView[];
}

/** A short colored badge for each provenance kind. */
function provenanceBadge(kind: string | null): string {
  switch (kind) {
    case "source-declared":
      return `${c.green}[source]${c.reset}`;
    case "content-derived":
      return `${c.blue}[content]${c.reset}`;
    case "cross-source-derived":
      return `${c.magenta}[x-source]${c.reset}`;
    case "llm-derived":
      return `${c.yellow}[llm]${c.reset}`;
    default:
      return `${c.dim}[unknown]${c.reset}`;
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function renderEdge(e: DocumentEdge): void {
  const arrow = e.direction === "outbound" ? "→" : "←";
  const badge = provenanceBadge(e.provenanceKind);
  const title = e.otherTitle ? truncate(e.otherTitle, 60) : `${c.dim}(unresolved)${c.reset}`;
  const docId = e.otherDocId ? `${c.dim}${e.otherDocId.slice(0, 8)}${c.reset}` : "";
  const origin = e.provenanceOrigin ? ` ${c.dim}via ${e.provenanceOrigin}${c.reset}` : "";
  console.log(`  ${arrow} ${c.bold}${e.linkType}${c.reset} ${badge} ${title} ${docId}${origin}`);
}

const edgesShowCommand = defineCommand({
  meta: {
    name: "show",
    description: "Show every edge incident to a document, with provenance",
  },
  args: {
    id: {
      type: "positional",
      description: "document ID (or unambiguous prefix)",
      required: true,
    },
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
    },
  },
  async run(ctx) {
    const id = ctx.args.id;
    if (!id) {
      throw new CliError(
        `${c.red}Usage: omnesis edges show <doc-id> [--json]${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const res = await withSpinner(`Loading edges for ${id.slice(0, 8)}`, () =>
      gw(`/documents/${encodeURIComponent(id)}/edges`),
    );
    const data = (await res.json()) as DocumentEdgesView | { error?: string; matches?: string[] };

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

    const view = data as DocumentEdgesView;

    if (isJSON) {
      console.log(JSON.stringify(view, null, 2));
      return;
    }

    const outbound = view.edges.filter((e) => e.direction === "outbound");
    const inbound = view.edges.filter((e) => e.direction === "inbound");

    if (outbound.length === 0 && inbound.length === 0 && view.pending.length === 0) {
      console.log(`${c.dim}No edges for this document.${c.reset}`);
      return;
    }

    if (outbound.length > 0) {
      console.log(`\n${c.bold}Outbound${c.reset} ${c.dim}(${outbound.length})${c.reset}`);
      for (const e of outbound) renderEdge(e);
    }
    if (inbound.length > 0) {
      console.log(`\n${c.bold}Inbound${c.reset} ${c.dim}(${inbound.length})${c.reset}`);
      for (const e of inbound) renderEdge(e);
    }
    if (view.pending.length > 0) {
      console.log(
        `\n${c.bold}Pending${c.reset} ${c.dim}(${view.pending.length} — declared, target not yet ingested)${c.reset}`,
      );
      for (const p of view.pending) {
        console.log(
          `  ⏳ ${c.bold}${p.linkType}${c.reset} → ${p.targetSourceId}/${p.targetExternalId} ${c.dim}(attempts: ${p.attemptCount})${c.reset}`,
        );
      }
    }
    console.log();
  },
});

export const edgesCommand = defineCommand({
  meta: { name: "edges", description: "Inspect a document's reference-graph edges" },
  subCommands: {
    show: edgesShowCommand,
  },
});
