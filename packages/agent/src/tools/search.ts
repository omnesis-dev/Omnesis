// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `search_documents` — the agent's workhorse retrieval tool.
 *
 * Takes a natural-language query plus optional structural filters, runs it
 * through the gateway's `SearchPipeline` (via `SearchPort`), and returns the
 * top-N compact `DocRef`s as a `search.results` tool result.
 *
 * The agent should describe what it's looking for in plain text *before*
 * calling this tool — the renderer surfaces the `intent` and `query`
 * inline so a demo audience can follow along.
 */

import { z } from "zod";

import { UnsupportedSearchFilterError, type SearchPort } from "./types.js";
import type { ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";

/**
 * Build the `search_documents` argument schema. A fresh instance per call so
 * each tool owns its own schema object.
 */
export function buildSearchDocumentsArgsSchema() {
  return z.object({
    query: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        "Search query in the gateway's search syntax. Supports operators like " +
          "from:NAME, to:NAME, source:TYPE, after:DATE, before:DATE, and plain " +
          "free text. The pipeline handles tokenization, BM25, and vectors.",
      ),
    filters: z
      .object({
        sourceIds: z.array(z.string()).optional(),
        documentTypes: z.array(z.string()).optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      })
      .optional(),
    limit: z.number().int().min(1).max(50).optional(),
  });
}

/**
 * The argument schema. Exported for consumers that need the shape (type
 * inference, tests); `createSearchDocumentsTool` builds its own instance.
 */
export const searchDocumentsArgsSchema = buildSearchDocumentsArgsSchema();

export type SearchDocumentsArgs = z.infer<typeof searchDocumentsArgsSchema>;

export interface SearchToolDeps {
  port: SearchPort;
  /** Default limit when the model omits one. */
  defaultLimit?: number;
}

export function createSearchDocumentsTool(deps: SearchToolDeps): ToolHandle {
  const defaultLimit = deps.defaultLimit ?? 8;
  const schema = buildSearchDocumentsArgsSchema();

  return {
    name: "search_documents",
    description:
      "Search the user's indexed documents (email, chat, notes, calendar, files) " +
      "by free-text query plus optional filters. Returns the most relevant " +
      "documents with brief snippets — call fetch_document to read a full " +
      "body. Prefer one specific search over many broad ones.",
    schema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const a = args as Record<string, unknown>;
      if (typeof a.query !== "string") return undefined;
      const extras: string[] = [];
      if (typeof a.limit === "number") extras.push(`limit=${a.limit}`);
      return extras.length > 0 ? `${a.query} (${extras.join(", ")})` : a.query;
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      const args = parsed.data;
      try {
        const r = await deps.port.search(
          {
            query: args.query,
            filters: args.filters,
            limit: args.limit ?? defaultLimit,
            currentConversationId: ctx.sessionId,
          },
          ctx.abortSignal,
        );
        return {
          kind: "search.results",
          query: r.query,
          durationMs: r.durationMs,
          candidates: r.totalCandidates,
          results: [...r.results],
        };
      } catch (err) {
        if (err instanceof UnsupportedSearchFilterError) {
          return { kind: "error", code: "unsupported_filter", message: err.message };
        }
        return {
          kind: "error",
          code: "search_failed",
          message: (err as Error).message ?? "search failed",
        };
      }
    },
  };
}
