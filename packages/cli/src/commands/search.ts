// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { parseSourceKey } from "@omnesis/core";
import {
  c,
  isJSON,
  formatDateShort,
  gw,
  buildCliFx,
  iconFor,
  linkify,
  buildResultUrl,
  withSpinner,
  CliError,
  EXIT_AUTH,
  EXIT_USER_ERROR,
  EXIT_GATEWAY_ERROR,
  EXIT_FAILURE,
} from "../utils.js";

export const searchCommand = defineCommand({
  meta: {
    name: "search",
    description: "Search across indexed documents",
  },
  args: {
    query: {
      type: "positional",
      description: "search query",
      required: true,
    },
    limit: {
      type: "string",
      description: "max results",
      default: "10",
    },
    verbose: {
      type: "boolean",
      alias: "v",
      description: "verbose output",
    },
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
    },
  },
  async run(ctx) {
    const { args } = ctx;
    // The `query` positional is `required: true`, so citty already gates the
    // command on it being non-empty; spreading `args._` into the join would
    // double the value because citty exposes named positionals in BOTH
    // `args.query` and `args._`.
    const query = args.query;
    if (!query) {
      throw new CliError(
        `${c.red}Usage: omnesis search <query> [--limit N] [-v]${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const limit = parseInt(args.limit, 10);
    if (Number.isNaN(limit)) {
      throw new CliError(`${c.red}--limit must be an integer${c.reset}`, EXIT_USER_ERROR);
    }
    const verbose = args.verbose;

    const searchQuery: Record<string, unknown> = { text: query, limit };

    const res = await withSpinner(`Searching "${query}"`, () =>
      gw("/search", {
        method: "POST",
        body: JSON.stringify(searchQuery),
      }),
    );

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      const code =
        res.status === 401 || res.status === 403
          ? EXIT_AUTH
          : res.status >= 500
            ? EXIT_GATEWAY_ERROR
            : res.status >= 400
              ? EXIT_USER_ERROR
              : EXIT_FAILURE;
      throw new CliError(`${c.red}${data.error ?? `Search failed: ${res.status}`}${c.reset}`, code);
    }

    const data = await res.json();

    if (isJSON) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (verbose) {
      console.log(`${c.dim}── Pipeline Debug ──${c.reset}`);
      console.log(`${c.dim}Query:    "${data.query.original}"${c.reset}`);
      if (data.query.effectiveText)
        console.log(`${c.dim}Effective: "${data.query.effectiveText}"${c.reset}`);
      const t = data.timing;
      const stages: string[] = [];
      if (t.bm25Ms != null) stages.push(`bm25: ${t.bm25Ms}ms`);
      if (t.vectorMs != null) stages.push(`vector: ${t.vectorMs}ms`);
      stages.push(`total: ${t.totalMs}ms`);
      console.log(`${c.dim}Timing:   ${stages.join(", ")}${c.reset}`);
      console.log(`${c.dim}────────────────────${c.reset}\n`);
    }

    if (data.results.length === 0) {
      console.log(`${c.dim}No results found for "${query}"${c.reset}`);
      return;
    }

    const fx = await buildCliFx();

    for (let i = 0; i < data.results.length; i++) {
      const r = data.results[i];
      const score = (r.score * 100).toFixed(1);
      const date = formatDateShort(r.sourceCreatedAt);
      const { sourceType } = parseSourceKey(r.sourceId);

      const srcIcon = iconFor(r.sourceId, fx);
      const srcIconPrefix = srcIcon ? `${srcIcon} ` : "";

      // Clickable title on OSC 8-capable terminals: cmd-click opens
      // the result's `sourceUrl`, the `OMNESIS_RESULT_URI` template, or the
      // portal doc page (see `buildResultUrl`). `linkify` is a no-op on
      // terminals without hyperlink support, so the plain title still prints.
      const title =
        r.documentId || r.sourceUrl
          ? linkify(r.title, buildResultUrl(r.documentId ?? "", r.sourceUrl), fx)
          : r.title;
      console.log(
        `${c.cyan}${i + 1}.${c.reset} ${srcIconPrefix}${c.bold}${title}${c.reset}  ${c.dim}(${score}%)${c.reset}`,
      );

      // Meta line — leads with the short document ID so the user can
      // copy it straight into `omnesis show <id>` (that endpoint accepts
      // any unambiguous prefix).
      const shortDocId = r.documentId ? r.documentId.slice(0, 8) : "";
      const meta: string[] = [];
      if (shortDocId) meta.push(`${c.dim}${shortDocId}${c.reset}`);
      meta.push(`${c.blue}${sourceType}${c.reset}`);
      if (r.documentType) meta.push(`${c.dim}${r.documentType}${c.reset}`);
      meta.push(`${c.dim}${date}${c.reset}`);
      if (r.author) meta.push(`${c.dim}${r.author}${c.reset}`);
      if (r.relevanceScore != null)
        meta.push(`${c.dim}rel:${(r.relevanceScore * 100).toFixed(0)}%${c.reset}`);
      if (r.refCount && r.refCount > 0) meta.push(`${c.magenta}${r.refCount} refs${c.reset}`);
      console.log(`   ${meta.join("  ")}`);

      const snippet = r.chunkText.replace(/\n+/g, " ").slice(0, 200).trim();
      console.log(`   ${c.gray}${snippet}${snippet.length >= 200 ? "..." : ""}${c.reset}`);
      if (r.sourceUrl) {
        console.log(`   ${c.dim}${linkify(r.sourceUrl, r.sourceUrl, fx)}${c.reset}`);
      }
      if (i < data.results.length - 1) console.log();
    }

    if (!verbose) {
      const t = data.timing;
      const parts: string[] = [`${t.totalMs}ms`];
      if (t.bm25Ms != null) parts.push(`bm25:${t.bm25Ms}ms`);
      if (t.vectorMs != null) parts.push(`vec:${t.vectorMs}ms`);
      console.log(`\n${c.dim}${data.results.length} results in ${parts.join(", ")}${c.reset}`);
    }
  },
});
