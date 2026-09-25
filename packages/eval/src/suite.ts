// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { resolve as pathResolve, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  SuiteRaw,
  type ExpectedDoc,
  type Suite,
  type SuiteQuery,
  type SuiteQueryRaw,
} from "./types.js";

/**
 * Resolve a suite argument to an absolute YAML path. A bare name like
 * `my-eval` maps to `~/.config/omnesis/evals/suites/my-eval.yaml`; anything
 * with a path separator, leading dot, or `.yaml`/`.yml` suffix is treated
 * as a path directly.
 */
export function resolveSuitePath(arg: string, configDir?: string): string {
  const isExplicitPath =
    arg.includes("/") || arg.startsWith(".") || arg.endsWith(".yaml") || arg.endsWith(".yml");
  if (isExplicitPath) return isAbsolute(arg) ? arg : pathResolve(process.cwd(), arg);
  const dir = configDir ?? process.env["OMNESIS_CONFIG_DIR"] ?? join(homedir(), ".config/omnesis");
  return join(dir, "evals", "suites", `${arg}.yaml`);
}

/**
 * Load and parse a suite YAML file, normalize URLs, and collapse the two
 * expected-doc forms (`expected_url` shorthand vs `expected_urls` array
 * with optional `aliases`) into a single `expectedDocs[]` list.
 *
 * Throws with a message that names the offending query id when a query
 * is missing both expected_url forms or has an empty alias group.
 */
export function loadSuite(suitePath: string): Suite {
  const text = readFileSync(suitePath, "utf-8");
  const sha256 = createHash("sha256").update(text).digest("hex");

  const yaml = parseYaml(text);
  const parsed = SuiteRaw.parse(yaml);

  const seenIds = new Set<string>();
  const queries: SuiteQuery[] = parsed.queries.map((raw) => {
    if (seenIds.has(raw.id)) {
      throw new Error(`Suite has duplicate query id: "${raw.id}"`);
    }
    seenIds.add(raw.id);
    return normalizeQuery(raw, parsed.default_top_k);
  });

  return {
    description: parsed.description,
    version: parsed.version,
    defaultTopK: parsed.default_top_k,
    queries,
    sourcePath: suitePath,
    sha256,
  };
}

function normalizeQuery(raw: SuiteQueryRaw, defaultTopK: number): SuiteQuery {
  const expectedDocs = collectExpectedDocs(raw);
  if (expectedDocs.length === 0) {
    throw new Error(
      `Query "${raw.id}" has neither expected_url nor expected_urls — at least one is required.`,
    );
  }
  return {
    id: raw.id,
    query: raw.query,
    expectedDocs,
    // URLs are kept verbatim from the YAML. Normalization (including
    // any source-specific canonicalization) is the gateway's job — the
    // eval package stays source-agnostic. The resolver passes raw URLs
    // to /documents/by-url and matches the response by the same string.
    unexpectedUrls: [...(raw.unexpected_urls ?? [])],
    type: raw.type,
    difficulty: raw.difficulty,
    notes: raw.notes,
    topK: raw.top_k ?? defaultTopK,
    mustRankAbove: raw.must_rank_above,
  };
}

function collectExpectedDocs(raw: SuiteQueryRaw): ExpectedDoc[] {
  const out: ExpectedDoc[] = [];
  if (raw.expected_url) out.push({ urls: [raw.expected_url] });
  if (raw.expected_urls) {
    for (const entry of raw.expected_urls) {
      if (typeof entry === "string") {
        out.push({ urls: [entry] });
      } else {
        out.push({ urls: [...entry.aliases] });
      }
    }
  }
  return out;
}

/**
 * Flat list of every URL in the suite, deduplicated. Used by the
 * resolver to make one batched /documents/by-url call instead of many.
 */
export function collectAllUrls(suite: Suite): string[] {
  const out = new Set<string>();
  for (const q of suite.queries) {
    for (const doc of q.expectedDocs) {
      for (const url of doc.urls) out.add(url);
    }
    for (const url of q.unexpectedUrls) out.add(url);
  }
  return [...out];
}
