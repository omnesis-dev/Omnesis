// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `fetch_document` — pull the full body of a document the agent already
 * surfaced via context or another retrieval tool.
 *
 * The agent uses this when a snippet isn't enough — usually one or two times
 * per turn, on the most relevant hits. The returned `document` payload is
 * opaque to the protocol; the gateway side wraps the stored `Document`
 * struct verbatim so the portal renderer can paint a source-shaped card.
 */

import { z } from "zod";

import { instantSafeEnd } from "../local-times.js";
import type { ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";
import type { CitationReads } from "./citation-reads.js";
import type { DocumentPort } from "./types.js";

export const fetchDocumentArgsSchema = z.object({
  documentId: z
    .string()
    .min(1)
    .describe(
      "Opaque documentId supplied in authorized context or returned by a retrieval tool. " +
        "Copy it exactly; do not add a prefix. An alias is allowed only when explicitly supported by this tool description.",
    ),
  contentOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Optional character offset for a bounded body read; use with maxContentChars."),
  maxContentChars: z
    .number()
    .int()
    .min(1)
    .max(65536)
    .optional()
    .describe(
      "Optional body character limit. Partial reads can be cited only with an exact quote from the returned span; fetch another span when needed.",
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
  citationReads?: CitationReads;
  /**
   * Body characters returned when a call names no `maxContentChars`. Unset
   * returns the whole body. A host whose sessions run long tool loops sets it
   * so one read cannot fill the model's context; longer bodies are paged.
   */
  defaultMaxContentChars?: number;
}

/** How the model pages a body longer than the default read, for tool descriptions. */
export function documentPagingNote(maxChars: number | undefined): string {
  return maxChars === undefined
    ? ""
    : ` A body longer than ${maxChars} characters returns its first ${maxChars} with contentRange.truncated and contentRange.nextOffset; read the rest by fetching again with contentOffset set to nextOffset.`;
}

export function createFetchDocumentTool(deps: FetchDocumentToolDeps): ToolHandle {
  return {
    name: "fetch_document",
    description:
      "Fetch the full body of a previously surfaced document. Returns the " +
      "document plus, if asked, its neighbors in the reference graph. Call " +
      "this when a search snippet is insufficient — don't fetch every " +
      "candidate, only the ones likely to answer the question." +
      (deps.port.supportsKnowledgeAliases
        ? " Also accepts wiki:<pageId> links from maintained context. Copy a wiki:<pageId> alias only from an actual wiki link. A knowledgeContext overlay separates claim provenance from navigation; its returned documentIds are opaque corpus IDs: copy them exactly into fetch tools, without adding wiki: or any other prefix. Missing or stale projections are unavailable, so use search instead."
        : "") +
      documentPagingNote(deps.defaultMaxContentChars),
    schema: fetchDocumentArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const a = args as Record<string, unknown>;
      if (typeof a.documentId !== "string") return undefined;
      return a.documentId.slice(0, 24);
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
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
        let document = r.document;
        let full = true;
        let observed: string | undefined;
        if (
          document &&
          typeof document === "object" &&
          "content" in document &&
          typeof document.content === "string"
        ) {
          const offset = args.contentOffset ?? 0;
          const limit =
            args.maxContentChars ??
            deps.defaultMaxContentChars ??
            (args.contentOffset === undefined ? document.content.length : 65536);
          // A page boundary inside an instant would leave its clock without
          // its offset; such a page ends before the instant instead.
          observed = document.content.slice(
            offset,
            instantSafeEnd(document.content, offset, offset + limit),
          );
          full = offset === 0 && observed.length === document.content.length;
          const end = offset + observed.length;
          if (!full)
            document = {
              ...document,
              content: observed,
              contentRange: {
                offset,
                returnedCharacters: observed.length,
                totalCharacters: document.content.length,
                truncated: true,
                ...(end < document.content.length ? { nextOffset: end } : {}),
              },
            };
        }
        deps.citationReads?.record(
          ctx,
          r,
          full,
          full ? undefined : { offset: args.contentOffset ?? 0, length: observed?.length ?? 0 },
        );
        // Port's `document` is typed as `unknown` so adapters can return
        // any shape; the protocol's `docBodySchema` is permissive
        // (passthrough on extra fields, every field optional except `id`).
        // We cast at this boundary; the schema validates at the wire side.
        return {
          kind: "document",
          ref: r.ref,
          document: document as ToolResult & { kind: "document" } extends {
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
