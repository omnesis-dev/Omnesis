// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  isJSON,
  formatTimeAgoMs,
  gw,
  withSpinner,
  CliError,
  EXIT_AUTH,
  EXIT_USER_ERROR,
  EXIT_GATEWAY_ERROR,
  EXIT_FAILURE,
} from "../utils.js";

interface PersonSearchResult {
  id: string;
  canonicalName: string;
  source: string;
  isSelf: boolean;
  aliasCount: number;
  documentCount: number;
  firstSeen: string;
  lastSeen: string;
  interactionScore: number;
  interactionScoreRecent: number;
  sourceIds: string[];
}

/**
 * Collect a person's aliases under the kind each one is.
 *
 * Keyed on `aliasType`, which is the field the gateway serves. Extracted so
 * the grouping has a test: the name is the whole of the logic, and a command
 * that declared a different one grouped every alias under a heading that read
 * `undefined` while typechecking perfectly.
 */
export function groupAliasesByType(
  aliases: readonly { aliasType: string; alias: string }[],
): Array<[string, string[]]> {
  const grouped = new Map<string, string[]>();
  for (const a of aliases) {
    const bucket = grouped.get(a.aliasType);
    if (bucket) bucket.push(a.alias);
    else grouped.set(a.aliasType, [a.alias]);
  }
  return [...grouped.entries()];
}

interface PersonDetail {
  id: string;
  canonicalName: string;
  isSelf: boolean;
  aliases: { aliasType: string; alias: string }[];
  documentCount: number;
  interactionScore: number;
  interactionScoreRecent: number;
  firstSeen: string;
  lastSeen: string;
}

const peopleSearchCommand = defineCommand({
  meta: { name: "search", description: "Fuzzy search people by name, email, phone, or handle" },
  args: {
    query: {
      type: "positional",
      description: "search query (name, email, phone, handle)",
      required: true,
    },
    limit: {
      type: "string",
      description: "max results (default 10)",
      default: "10",
    },
    aliases: {
      type: "boolean",
      description: "include full alias list for each result",
    },
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
    },
  },
  async run(ctx) {
    const { args } = ctx;
    const query = args.query;
    if (!query) {
      throw new CliError(
        `${c.red}Usage: omnesis people search <query> [--limit N] [--aliases]${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const limit = parseInt(args.limit, 10);
    if (Number.isNaN(limit)) {
      throw new CliError(`${c.red}--limit must be an integer${c.reset}`, EXIT_USER_ERROR);
    }

    const res = await withSpinner(`Searching people "${query}"`, () =>
      gw(`/people/search?q=${encodeURIComponent(query)}&limit=${limit}`),
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
      throw new CliError(
        `${c.red}${data.error ?? `People search failed: ${res.status}`}${c.reset}`,
        code,
      );
    }

    const data = (await res.json()) as { items: PersonSearchResult[] };
    const results = data.items;

    if (args.aliases) {
      const enriched: (PersonSearchResult & {
        aliases?: { aliasType: string; alias: string }[];
      })[] = [];
      for (const person of results) {
        const detailRes = await gw(`/people/${encodeURIComponent(person.id)}`);
        if (detailRes.ok) {
          const detail = (await detailRes.json()) as PersonDetail;
          enriched.push({ ...person, aliases: detail.aliases });
        } else {
          enriched.push(person);
        }
      }

      if (isJSON) {
        console.log(JSON.stringify(enriched, null, 2));
        return;
      }

      renderPeopleResults(enriched);
      return;
    }

    if (isJSON) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    renderPeopleResults(results);
  },
});

function renderPeopleResults(
  results: (PersonSearchResult & { aliases?: { aliasType: string; alias: string }[] })[],
): void {
  if (results.length === 0) {
    console.log(`${c.dim}No people found.${c.reset}`);
    return;
  }

  console.log();
  for (let i = 0; i < results.length; i++) {
    const p = results[i];
    const selfBadge = p.isSelf ? ` ${c.green}(you)${c.reset}` : "";
    const score = p.interactionScoreRecent ?? p.interactionScore ?? 0;
    const scoreStr = score > 0 ? `${c.cyan}score:${(score * 100).toFixed(0)}%${c.reset}` : "";

    console.log(
      `${c.cyan}${i + 1}.${c.reset} ${c.bold}${p.canonicalName}${c.reset}${selfBadge}  ${scoreStr}`,
    );

    const meta: string[] = [];
    meta.push(`${p.documentCount} docs`);
    if (p.lastSeen) meta.push(`last: ${formatTimeAgoMs(new Date(p.lastSeen).getTime())}`);
    console.log(`   ${c.dim}${meta.join("  ")}${c.reset}`);

    for (const [type, values] of groupAliasesByType(p.aliases ?? [])) {
      console.log(`   ${c.dim}${type}:${c.reset} ${values.join(", ")}`);
    }

    if (i < results.length - 1) console.log();
  }
  console.log();
}

export const peopleCommand = defineCommand({
  meta: {
    name: "people",
    description: "People graph queries",
  },
  subCommands: {
    search: () => Promise.resolve(peopleSearchCommand),
  },
});
