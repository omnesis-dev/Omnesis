// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `fetch_document` — pull the full body of a document the agent already
 * surfaced via `search_documents`.
 *
 * The agent uses this when a snippet isn't enough — usually one or two times
 * per turn, on the most relevant hits. The returned `document` payload is
 * opaque to the protocol; the gateway side wraps the stored `Document`
 * struct verbatim so the portal renderer can paint a source-shaped card.
 */

import { z } from "zod";

import type { ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";
import type { DocumentPort } from "./types.js";

export const fetchDocumentArgsSchema = z.object({
  documentId: z
    .string()
    .min(1)
    .describe(
      "Document ID returned by a prior search_documents call (the `documentId` " +
        "field on a result item).",
    ),
  includeNeighbors: z
    .boolean()
    .optional()
    .describe(
      "When true, also returns the documents that link to and from this one. " +
        "Useful for tracing the reference graph (an email's attached PDF, a " +
        "page's child pages).",
    ),
});

export type FetchDocumentArgs = z.infer<typeof fetchDocumentArgsSchema>;

export interface FetchDocumentToolDeps {
  port: DocumentPort;
}

export function createFetchDocumentTool(deps: FetchDocumentToolDeps): ToolHandle {
  return {
    name: "fetch_document",
    description:
      "Fetch the full body of a previously surfaced document. Returns the " +
      "document plus, if asked, its neighbors in the reference graph. Call " +
      "this when a search snippet is insufficient — don't fetch every " +
      "candidate, only the ones likely to answer the question.",
    schema: fetchDocumentArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const a = args as Record<string, unknown>;
      if (typeof a.documentId !== "string") return undefined;
      return a.documentId.slice(0, 24);
    },
    async invoke(rawArgs: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const parsed = fetchDocumentArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      const args = parsed.data;
      try {
        const r = await deps.port.fetch(args.documentId, {
          includeNeighbors: args.includeNeighbors ?? false,
        });
        if (!r) {
          return {
            kind: "error",
            code: "not_found",
            message: `no document with id ${args.documentId}`,
          };
        }
        // Port's `document` is typed as `unknown` so adapters can return
        // any shape; the protocol's `docBodySchema` is permissive
        // (passthrough on extra fields, every field optional except `id`).
        // We cast at this boundary; the schema validates at the wire side.
        return {
          kind: "document",
          ref: r.ref,
          document: r.document as ToolResult & { kind: "document" } extends {
            document: infer D;
          }
            ? D
            : never,
          neighbors: r.neighbors ? [...r.neighbors] : undefined,
          neighborsTruncated: r.neighborsTruncated,
        };
      } catch (err) {
        return {
          kind: "error",
          code: "fetch_failed",
          message: (err as Error).message ?? "fetch failed",
        };
      }
    },
  };
}
