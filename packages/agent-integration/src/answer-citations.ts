// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

/**
 * Request metadata by which a native integration declares it accepts
 * `citations` on a released Answer result. The gateway withholds them from a
 * bound integration that does not send it, because a plugin that predates
 * citations rejects fields it does not know.
 */
export const ANSWER_CITATIONS_META_KEY = "dev.omnesis/answerCitations";

/** The most citations the gateway releases beside one answer. */
const MAX_ANSWER_CITATIONS = 32;
const MAX_CITATION_URL_CHARS = 2_048;

/**
 * One document the answer relies on, as the gateway releases it after privacy
 * review. The key set is exact: anything else fails closed.
 */
const answerCitationSchema = z
  .object({
    documentId: z.string().min(1).max(200),
    sourceType: z.string().min(1).max(100),
    title: z.string().min(1).max(300).optional(),
    timestamp: z.string().datetime({ offset: true }).optional(),
    sourceUrl: z.string().min(1).max(MAX_CITATION_URL_CHARS).optional(),
    appUrl: z.string().min(1).max(MAX_CITATION_URL_CHARS).optional(),
  })
  .strict();

export const answerCitationsSchema = z.array(answerCitationSchema).max(MAX_ANSWER_CITATIONS);

/**
 * The citations of a released answer rendered compactly for a model or a
 * chat: one numbered line per document (title · source · date), then its
 * links. Returns null when the response carries no well-formed citations.
 */
export function formatAnswerCitations(response: unknown): string | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const parsed = answerCitationsSchema.safeParse((response as { citations?: unknown }).citations);
  if (!parsed.success || parsed.data.length === 0) return null;
  const lines = ["Sources:"];
  parsed.data.forEach((citation, index) => {
    const label = [citation.title ?? "Untitled", citation.sourceType, citation.timestamp]
      .filter((part): part is string => Boolean(part))
      .map(singleLine)
      .join(" · ");
    lines.push(`${index + 1}. ${label}`);
    if (citation.sourceUrl) lines.push(`   Link: ${singleLine(citation.sourceUrl)}`);
    if (citation.appUrl) lines.push(`   App link: ${singleLine(citation.appUrl)}`);
  });
  return lines.join("\n");
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_OR_LINE_BREAK = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** Document text on one line, so a title cannot fake further lines of the list. */
function singleLine(value: string): string {
  return value.replace(CONTROL_OR_LINE_BREAK, " ").trim();
}
