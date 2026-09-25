// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { collectAllUrls, loadSuite, resolveSuite, resolveSuitePath } from "@omnesis/eval";
import { c, CliError, EXIT_USER_ERROR, gatewayJson, isJSON } from "../utils.js";
import { buildContentHashSiblingsResolver } from "./eval-shared.js";

export const evalDoctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Validate an eval suite against the live index",
  },
  args: {
    suite: {
      type: "positional",
      required: true,
      description: "Suite name (under ~/.config/omnesis/evals/suites/) or path to YAML file",
    },
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
    },
    "no-content-hash-expansion": {
      type: "boolean",
      description:
        "Skip auto-expansion of expected docs by content_hash siblings. By default, every " +
        "expected docId in the suite is unioned with every other indexed docId sharing its " +
        "content_hash (mirrors the search pipeline's dedupeByContentHash). Opt out here when " +
        "you want to test the suite as-written without sibling forgiveness.",
    },
  },
  async run(ctx) {
    const suitePath = resolveSuitePath(ctx.args.suite as string);
    let suite;
    try {
      suite = loadSuite(suitePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(`Failed to load suite ${suitePath}: ${msg}`, EXIT_USER_ERROR);
    }

    const allUrls = collectAllUrls(suite);
    const { matches } = await gatewayJson<{ matches: Record<string, string[]> }>(
      "/documents/by-url",
      { method: "POST", body: JSON.stringify({ urls: allUrls }) },
    );

    const matchMap = new Map(Object.entries(matches));
    const expansionEnabled = !(
      ctx.args["no-content-hash-expansion"] === true || ctx.args["content-hash-expansion"] === false
    );
    const { resolvedDocIdGroups, unresolved, expandedDocCount } = await resolveSuite(
      suite,
      async (urls) => {
        // URLs are kept verbatim on both sides — the gateway normalizes on
        // the join, so a raw suite-side URL looks up directly against the
        // raw response map.
        const out = new Map<string, string[]>();
        for (const u of urls) {
          const ids = matchMap.get(u);
          if (ids && ids.length > 0) out.set(u, ids);
        }
        return out;
      },
      expansionEnabled ? buildContentHashSiblingsResolver() : undefined,
    );

    const totalQueries = suite.queries.length;
    const totalExpectedDocs = suite.queries.reduce((acc, q) => acc + q.expectedDocs.length, 0);
    const resolvedDocs = resolvedDocIdGroups.reduce(
      (acc, q) => acc + q.filter((g) => g.length > 0).length,
      0,
    );

    if (isJSON || ctx.args.json) {
      console.log(
        JSON.stringify(
          {
            suite_path: suite.sourcePath,
            sha256: suite.sha256,
            total_queries: totalQueries,
            total_expected_docs: totalExpectedDocs,
            resolved_expected_docs: resolvedDocs,
            expanded_expected_docs: expandedDocCount,
            content_hash_expansion: expansionEnabled,
            unresolved,
            ok: unresolved.length === 0,
          },
          null,
          2,
        ),
      );
      if (unresolved.length > 0) throw new CliError("", EXIT_USER_ERROR);
      return;
    }

    console.log(
      `${c.bold}Suite${c.reset}: ${suite.description} (${totalQueries} queries, ${totalExpectedDocs} expected docs)`,
    );
    console.log(`${c.dim}Path${c.reset}: ${suite.sourcePath}`);
    console.log(`${c.dim}SHA256${c.reset}: ${suite.sha256.slice(0, 12)}…`);
    if (expansionEnabled) {
      const delta = expandedDocCount - resolvedDocs;
      console.log(
        `${c.dim}Expanded${c.reset}: ${expandedDocCount} docs after content-hash sibling expansion` +
          (delta > 0 ? ` (+${delta} added)` : ""),
      );
    } else {
      console.log(`${c.dim}Expanded${c.reset}: content-hash sibling expansion disabled`);
    }
    console.log("");

    if (unresolved.length === 0) {
      console.log(`${c.green}✓${c.reset} All ${totalExpectedDocs} expected docs resolved.`);
      return;
    }

    console.log(
      `${c.red}✗${c.reset} ${unresolved.length} URL(s) did not resolve to a document in the index:\n`,
    );
    for (const u of unresolved) {
      console.log(`  ${c.red}[${u.queryId}]${c.reset} ${u.url}`);
    }
    console.log("");
    console.log(
      `${c.yellow}Hint${c.reset}: open one of these URLs in the portal — if the doc isn't there, it's not in the index, and the fixture needs to use a URL that is.`,
    );
    throw new CliError("", EXIT_USER_ERROR);
  },
});
