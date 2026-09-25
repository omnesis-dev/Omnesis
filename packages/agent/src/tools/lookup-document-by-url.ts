// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `lookup_document_by_url` — resolve a source URL to the metadata of
 * the matching document in the user's corpus. The user often quotes a
 * URL verbatim ("anything about
 * https://docs.google.com/document/d/1abc.../edit?usp=sharing", "what
 * are my notes on https://news.ycombinator.com/item?id=42"); search is
 * a poor fit because the URL string itself is rarely indexed cleanly.
 * This tool runs the same canonicaliser chain ingest uses and returns
 * at most one DocRef (metadata only — no body). Pair with
 * `fetch_document(documentId)` to actually read the content.
 *
 * Returns a `document.byUrl` tool result. The portal + iOS surface it
 * as an ephemeral rolling-slot card identical in chrome to
 * `search_documents` so the visual reads as "found it" without
 * cluttering the transcript with a third permanent card.
 */

import { z } from "zod";

import type { ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";
import type { DocumentByUrlPort } from "./types.js";

export const lookupDocumentByUrlArgsSchema = z.object({
  url: z
    .string()
    .min(1)
    .max(2_000)
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, "url must not be blank")
    .describe(
      "Full source URL of the document — pass exactly what the user " +
        "pasted; the gateway canonicalises before matching, so query " +
        "strings, tracking parameters, and mobile-app redirects all " +
        "normalise the same way they did at ingest.",
    ),
});

export type LookupDocumentByUrlArgs = z.infer<typeof lookupDocumentByUrlArgsSchema>;

export interface LookupDocumentByUrlToolDeps {
  port: DocumentByUrlPort;
}

export function createLookupDocumentByUrlTool(deps: LookupDocumentByUrlToolDeps): ToolHandle {
  return {
    name: "lookup_document_by_url",
    description:
      "Resolve a source URL to its document metadata in the user's " +
      "corpus. Returns at most one `DocRef` — same shape as a " +
      "`search_documents` row (documentId, title, snippet, sourceId, " +
      "ts), metadata only — or no ref at all when the URL isn't in the " +
      "corpus. The URL is canonicalised the same way it was at ingest " +
      "(tracking params stripped, mobile-app redirects unwound), so " +
      "you can pass the user's exact paste. When a URL fans out to " +
      "several docs (an email and its attachments share a source_url), " +
      "the resolver returns the document with the earliest " +
      "`source_created_at` — typically the parent, since attachments " +
      "ingest after their parent. **This tool does NOT read the " +
      "document body** — to actually open the content, pass the " +
      "returned `documentId` to `fetch_document`. Use BEFORE " +
      "`search_documents` whenever the user includes a URL in their " +
      "question — it's a single SQL lookup, much cheaper and more " +
      "precise than embedding search over a URL token. An absent " +
      "`ref` means the URL points outside the user's corpus (e.g. a " +
      "public webpage they haven't saved); not an error.",
    schema: lookupDocumentByUrlArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const a = args as Record<string, unknown>;
      if (typeof a.url !== "string") return undefined;
      return a.url.slice(0, 80);
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = lookupDocumentByUrlArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      const args = parsed.data;
      try {
        const result = await deps.port.lookup(args.url, ctx.abortSignal);
        return {
          kind: "document.byUrl",
          url: result.url,
          durationMs: result.durationMs,
          ref: result.ref ? { ...result.ref } : undefined,
        };
      } catch (err) {
        return {
          kind: "error",
          code: "lookup_failed",
          message: (err as Error).message ?? "lookup_document_by_url failed",
        };
      }
    },
  };
}
