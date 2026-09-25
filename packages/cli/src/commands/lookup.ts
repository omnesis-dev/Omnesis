// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  isJSON,
  formatDateShort,
  gw,
  buildCliFx,
  iconFor,
  withSpinner,
  CliError,
  EXIT_USER_ERROR,
  EXIT_AUTH,
  EXIT_GATEWAY_ERROR,
  EXIT_FAILURE,
} from "../utils.js";

export const lookupCommand = defineCommand({
  meta: {
    name: "lookup",
    description: "Find documents by source URL (canonicalized)",
  },
  args: {
    url: {
      type: "positional",
      description: "source URL (e.g. https://docs.google.com/document/d/.../edit)",
      required: true,
    },
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
    },
  },
  async run(ctx) {
    const { args } = ctx;
    const url = args.url;
    if (!url) {
      throw new CliError(`${c.red}Usage: omnesis lookup <url>${c.reset}`, EXIT_USER_ERROR);
    }

    const lookupRes = await withSpinner(`Looking up ${url}`, () =>
      gw(`/documents/by-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: [url] }),
      }),
    );
    if (!lookupRes.ok) {
      const data = (await lookupRes.json().catch(() => ({}))) as { error?: string };
      throw new CliError(
        `${c.red}${data.error ?? `Request returned ${lookupRes.status}`}${c.reset}`,
        statusToExit(lookupRes.status),
      );
    }
    const { matches } = (await lookupRes.json()) as { matches: Record<string, string[]> };

    // Endpoint keys responses by the original URL. We sent exactly one,
    // so the only entry — if any — is keyed by `url`.
    const ids = matches[url] ?? [];

    if (isJSON) {
      // Mirror the gateway response shape so `--json` consumers don't have
      // to re-piece the single-url case differently from a batch.
      if (ids.length === 0) {
        console.log(JSON.stringify({ url, documents: [] }, null, 2));
        return;
      }
      const docs = await fetchDocs(ids);
      console.log(
        JSON.stringify(
          {
            url,
            documents: ids.map((id) => docs[id] ?? { id, missing: true }),
          },
          null,
          2,
        ),
      );
      return;
    }

    if (ids.length === 0) {
      console.log(`${c.dim}No documents match ${url}${c.reset}`);
      return;
    }

    const docs = await fetchDocs(ids);
    const fx = await buildCliFx();

    // Build rows in input-id order so two runs against a stable corpus
    // print identically; SQL `IN (...)` returns rows in arbitrary order.
    type Row = { id: string; date: string; sourceId: string; title: string; icon: string };
    const rows: Row[] = ids.map((id) => {
      const doc = docs[id];
      if (!doc) {
        return { id, date: "", sourceId: "(missing)", title: "", icon: "" };
      }
      const sourceId = String(doc.source_id ?? "");
      const icon = iconFor(sourceId, fx);
      return {
        id,
        date: formatDateShort(String(doc.source_created_at ?? "")),
        sourceId,
        title: String(doc.title ?? ""),
        icon,
      };
    });

    const sourceCellWidth = Math.max(
      ...rows.map((r) => (r.icon ? r.icon.length + 1 : 0) + r.sourceId.length),
    );

    console.log(
      `\n${c.bold}${ids.length} ${ids.length === 1 ? "match" : "matches"}${c.reset} ${c.dim}for${c.reset} ${c.cyan}${url}${c.reset}\n`,
    );
    for (const r of rows) {
      const sourcePlain = (r.icon ? `${r.icon} ` : "") + r.sourceId;
      const padding = " ".repeat(Math.max(0, sourceCellWidth - sourcePlain.length));
      const sourceCell = `${r.icon ? `${r.icon} ` : ""}${c.cyan}${r.sourceId}${c.reset}${padding}`;
      console.log(`${c.dim}${r.id.slice(0, 8)}${c.reset}  ${r.date}  ${sourceCell}  ${r.title}`);
    }
    console.log(`\n${c.dim}Run ${c.reset}omnesis show <id>${c.dim} to view a document.${c.reset}`);
  },
});

async function fetchDocs(ids: readonly string[]): Promise<Record<string, Record<string, unknown>>> {
  // /documents/bulk caps at 100 ids per call. Real-world matches are tiny
  // (an email + a handful of attachments), so one call is enough; chunk
  // defensively in case a future canonicalizer collapses many rows.
  const out: Record<string, Record<string, unknown>> = {};
  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const res = await gw(`/documents/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: chunk }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new CliError(
        `${c.red}${data.error ?? `Request returned ${res.status}`}${c.reset}`,
        statusToExit(res.status),
      );
    }
    const { docs } = (await res.json()) as { docs: Record<string, Record<string, unknown>> };
    Object.assign(out, docs);
  }
  return out;
}

function statusToExit(status: number): number {
  if (status === 401 || status === 403) return EXIT_AUTH;
  if (status >= 500) return EXIT_GATEWAY_ERROR;
  if (status >= 400) return EXIT_USER_ERROR;
  return EXIT_FAILURE;
}
