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

export const recentCommand = defineCommand({
  meta: {
    name: "recent",
    description: "List recent documents for a source",
  },
  args: {
    sourceId: {
      type: "positional",
      description: "source ID (e.g. gmail:user@gmail.com)",
      required: true,
    },
    limit: {
      type: "string",
      description: "max results",
      default: "10",
    },
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
    },
  },
  async run(ctx) {
    const { args } = ctx;
    const sourceId = args.sourceId;
    if (!sourceId) {
      throw new CliError(
        `${c.red}Usage: omnesis recent <source-id> [--limit N]${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const limit = parseInt(args.limit, 10);
    if (Number.isNaN(limit)) {
      throw new CliError(`${c.red}--limit must be an integer${c.reset}`, EXIT_USER_ERROR);
    }

    const params = new URLSearchParams({ limit: String(limit) });
    const res = await withSpinner(`Loading recent for ${sourceId}`, () =>
      gw(`/documents/recent/${encodeURIComponent(sourceId)}?${params}`),
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
        `${c.red}${data.error ?? `Request returned ${res.status}`}${c.reset}`,
        code,
      );
    }

    const data = (await res.json()) as { documents: Array<Record<string, unknown>> };

    if (isJSON) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (data.documents.length === 0) {
      console.log(`${c.dim}No documents found for ${sourceId}${c.reset}`);
      return;
    }

    const fx = await buildCliFx();
    const srcIcon = iconFor(sourceId, fx);
    const srcIconPrefix = srcIcon ? `${srcIcon} ` : "";

    console.log(`\n${c.bold}${srcIconPrefix}Recent documents for ${sourceId}${c.reset}\n`);
    for (const doc of data.documents) {
      const date = formatDateShort(doc.sourceCreatedAt as string);
      const shortId = (doc.id as string).slice(0, 8);
      const relScore =
        doc.relevanceScore != null
          ? `  ${c.dim}rel:${((doc.relevanceScore as number) * 100).toFixed(0)}%${c.reset}`
          : "";
      console.log(`${c.dim}${shortId}${c.reset}  ${date}  ${doc.title}${relScore}`);
    }
    console.log(`\n${c.dim}${data.documents.length} documents${c.reset}`);
  },
});
