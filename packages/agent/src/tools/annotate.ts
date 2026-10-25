// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `annotate` — mark a document that materially informed the agent's
 * answer with an optional short quote and/or one-line note.
 *
 * The gateway fetches the document to validate its id and obtain the
 * canonical `ref` for the sidebar card. A missing document returns an
 * actionable error so the agent can resolve the real document id and
 * retry instead of creating a broken citation. Read-enforcing ports validate
 * supplied quotes against the observed body or partial span. Successful citations bubble up to the portal sidebar
 * + iOS card via the session, which synthesises an `agent.citation` event
 * from each `annotate.recorded` result.
 */

import { z } from "zod";

import { assertNever, isSelfQuoteAuthor, type ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";
import type { CitationReadResolution, CitationReads } from "./citation-reads.js";
import type { DocumentPort } from "./types.js";

export const annotateArgsSchema = z.object({
  documentId: z
    .string()
    .min(1)
    .describe(
      "Canonical documentId copied from search_many, fetch_many, " +
        "lookup_document_by_url, or trace_connections. Never pass a raw " +
        "run_sql row value; cite an addressable SQL row with cite_record.",
    ),
  quote: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe(
      "Short excerpt from the document body that supports the cited fact. " +
        "Prefer one short sentence (≤25 words). Must exactly match the observed body; required for a partial read and limited to its returned span.",
    ),
  quoteAuthor: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Who wrote or said the quoted text (first name or short display name). " +
        "Only when `quote` is present AND you are certain of the attribution " +
        '(email sender, chat speaker). Use "You" when the author is the user ' +
        "(the isSelf person in the corpus). Omit for files, attachments, or " +
        "any doc where authorship is ambiguous.",
    ),
  note: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Short one-line note explaining why this document supports the answer. " +
        "Use it when the document has no quotable text body or alongside a quote " +
        "as a 'why this matters' caption.",
    ),
});

export type AnnotateArgs = z.infer<typeof annotateArgsSchema>;

export interface AnnotateToolDeps {
  port: DocumentPort;
  citationReads?: CitationReads;
}

export function createAnnotateTool(deps: AnnotateToolDeps): ToolHandle {
  return {
    name: "annotate",
    description:
      "Mark a document that materially informed your answer. Provide the " +
      "documentId plus a short `quote` from the document body and/or a " +
      "one-line `note` (used when the source is non-text, or alongside a " +
      "quote as a 'why this matters' caption). The documentId is validated; " +
      "if it is missing or invalid, resolve the canonical documentId and retry." +
      (deps.port.requiresCitationRead
        ? " First fetch the cited document in this turn. A fetched wiki is directly citable; its source pointers alone do not authorize original-source citations. Partial reads require an exact quote from the returned span. This checks exposure and freshness, not truth."
        : ""),
    schema: annotateArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const a = args as Record<string, unknown>;
      const id = typeof a.documentId === "string" ? a.documentId.slice(0, 24) : "";
      const text =
        (typeof a.quote === "string" ? a.quote : typeof a.note === "string" ? a.note : "") ?? "";
      return text ? `${id}: "${text.slice(0, 40)}"` : id;
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = annotateArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      const args = parsed.data;
      try {
        const fetched = await deps.port.fetch(args.documentId, { includeNeighbors: false });
        if (!fetched) {
          return {
            kind: "error",
            code: "document_not_found",
            message:
              `No indexed document has id ${JSON.stringify(args.documentId)}. ` +
              "documentId must come from a document result such as search_many or fetch_many, " +
              "not from a raw run_sql row. Find the canonical document and retry " +
              "annotate_many; if run_sql returned a non-null rowIdentities[i], use " +
              "cite_record instead. No citation was recorded.",
          };
        }
        const observed = deps.port.requiresCitationRead
          ? (deps.citationReads?.resolveDetailed(ctx, fetched, args.quote) ?? {
              ok: false as const,
              reason: "unread" as const,
              full: false,
            })
          : { ok: true as const, quote: args.quote };
        if (!observed.ok) {
          return {
            kind: "error",
            code: "citation_read_required",
            message: citationRecovery(observed),
          };
        }
        const quoteAuthor = args.quote ? args.quoteAuthor : undefined;
        return {
          kind: "annotate.recorded",
          documentId: fetched.ref.documentId,
          ref: fetched.ref,
          quote: observed.quote,
          quoteAuthor,
          // Resolve the agent's "You" convention to a boolean here so the
          // wire carries the orientation hint and renderers never re-derive
          // identity. Only meaningful alongside a quote.
          quoteIsSelf: isSelfQuoteAuthor(quoteAuthor) ? true : undefined,
          note: args.note,
        };
      } catch {
        return {
          kind: "error",
          code: "document_lookup_failed",
          message:
            `Could not validate document ${JSON.stringify(args.documentId)}. ` +
            "Retry annotate_many; no citation was recorded.",
        };
      }
    },
  };
}

/** No IDs, body text or version values are exposed by recovery diagnostics. */
function citationRecovery(failure: Extract<CitationReadResolution, { ok: false }>): string {
  const prefix = "No citation recorded. ";
  switch (failure.reason) {
    case "unread":
      return (
        prefix +
        "This document has no current explicit read in this turn. Fetch it with fetch_many first. A wiki or loop source pointer is not a read of that source; a fetched wiki may be cited directly."
      );
    case "changed":
      return (
        prefix +
        "The document changed after its recorded read. Fetch it again with fetch_many and inspect the current body before citing it."
      );
    case "quote_required":
      return (
        prefix +
        "This was a bounded body read. Supply an exact quote from the returned span; omitting the quote does not authorize the unread remainder."
      );
    case "body_unavailable":
      return (
        prefix +
        "The current document has no text body available to validate this quote." +
        (failure.full
          ? " Omit quote and cite the fully read document with a short note."
          : " Fetch an available text body before quoting it.")
      );
    case "quote_mismatch":
    case "quote_ambiguous":
      return (
        prefix +
        (failure.reason === "quote_ambiguous"
          ? "The quote has multiple whitespace-equivalent matches in the observed text. "
          : "The quote does not match the observed text. ") +
        "Correct the quote rather than repeating it unchanged: copy a contiguous observed passage, retaining punctuation and quoted-reply prefixes." +
        (failure.full
          ? " You may instead omit quote and cite the fully read document with a short note."
          : " Use only the returned span; omitting quote does not authorize the unread remainder.")
      );
    default:
      return assertNever(failure.reason);
  }
}
