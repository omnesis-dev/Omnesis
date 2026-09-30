// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

import { z } from "zod";

import {
  ANSWER_CITATION_WITHHOLDABLE_FIELDS,
  type AnswerCitation,
  type AnswerCitationWithholdableField,
} from "@omnesis/types/privacy";

/**
 * Citations released beside one answer. An answer that leans on more
 * documents than this still names the ones that matter most first: the
 * agent's own citation order is kept and the tail is dropped.
 */
export const MAX_ANSWER_CITATIONS = 32;
const MAX_CITATION_TITLE_CHARS = 300;
/** A link longer than this is not a link a person follows; it is withheld. */
const MAX_CITATION_URL_CHARS = 2_048;

const answerCitationSchema = z
  .object({
    documentId: z.string().min(1).max(200),
    sourceType: z.string().min(1).max(100),
    title: z.string().min(1).max(MAX_CITATION_TITLE_CHARS).optional(),
    timestamp: z.string().datetime({ offset: true }).optional(),
    sourceUrl: z.string().min(1).max(MAX_CITATION_URL_CHARS).optional(),
    appUrl: z.string().min(1).max(MAX_CITATION_URL_CHARS).optional(),
  })
  .strict();

export const answerCitationsSchema = z.array(answerCitationSchema).max(MAX_ANSWER_CITATIONS);

/** The citable fields of a document reference, as the agent's citation tool resolves them. */
export interface CitableDocumentRef {
  documentId: string;
  sourceType: string;
  title?: string;
  ts?: number;
  url?: string;
  appUrl?: string;
}

/**
 * The public citation for a document the agent cited. Every value comes from
 * the gateway's own record of the document, never from the model.
 */
export function answerCitationFromDocRef(ref: CitableDocumentRef): AnswerCitation {
  const title = ref.title === undefined ? undefined : singleLine(ref.title);
  const timestamp =
    typeof ref.ts === "number" && Number.isFinite(ref.ts) ? isoTimestamp(ref.ts) : undefined;
  return {
    documentId: ref.documentId,
    sourceType: ref.sourceType,
    ...(title ? { title: truncate(title, MAX_CITATION_TITLE_CHARS) } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(usableUrl(ref.url) ? { sourceUrl: ref.url } : {}),
    ...(usableUrl(ref.appUrl) ? { appUrl: ref.appUrl } : {}),
  };
}

/**
 * Collects the documents one answer cites, in first-cited order, once each.
 * A repeat citation of the same document adds nothing to the released
 * metadata: it is the same pointer.
 */
export class AnswerCitationCollector {
  private readonly byDocumentId = new Map<string, AnswerCitation>();

  add(ref: CitableDocumentRef): void {
    if (this.byDocumentId.has(ref.documentId)) return;
    if (this.byDocumentId.size >= MAX_ANSWER_CITATIONS) return;
    // A document whose record cannot make a valid citation — an id past the
    // bound, a time no ISO 8601 instant can name — is left uncited rather than
    // stored in a shape every later read would refuse.
    const citation = answerCitationSchema.safeParse(answerCitationFromDocRef(ref));
    if (citation.success) this.byDocumentId.set(ref.documentId, citation.data);
  }

  snapshot(): AnswerCitation[] {
    return [...this.byDocumentId.values()];
  }
}

/** One reviewer instruction to withhold a citation, or some of its fields. */
export interface AnswerCitationReduction {
  /** One-based position of the citation in the reviewed list. */
  citation: number;
  /** `citation` withholds the whole entry; a field name withholds only that field. */
  withhold: Array<"citation" | AnswerCitationWithholdableField>;
}

export const answerCitationReductionSchema = z
  .object({
    citation: z.number().int().min(1).max(MAX_ANSWER_CITATIONS),
    withhold: z
      .array(z.enum(["citation", ...ANSWER_CITATION_WITHHOLDABLE_FIELDS]))
      .min(1)
      .max(ANSWER_CITATION_WITHHOLDABLE_FIELDS.length + 1),
  })
  .strict();

/**
 * Apply a reviewer's citation reductions. Positions that name no citation are
 * ignored rather than trusted to mean something else.
 */
export function applyCitationReductions(
  citations: readonly AnswerCitation[],
  reductions: readonly AnswerCitationReduction[],
): AnswerCitation[] {
  const withheld = new Map<number, Set<string>>();
  for (const reduction of reductions) {
    const fields = withheld.get(reduction.citation) ?? new Set<string>();
    for (const field of reduction.withhold) fields.add(field);
    withheld.set(reduction.citation, fields);
  }
  const reduced: AnswerCitation[] = [];
  citations.forEach((citation, index) => {
    const fields = withheld.get(index + 1);
    if (!fields) {
      reduced.push(citation);
      return;
    }
    if (fields.has("citation")) return;
    const kept: AnswerCitation = { ...citation };
    for (const field of ANSWER_CITATION_WITHHOLDABLE_FIELDS) {
      if (fields.has(field)) delete kept[field];
    }
    reduced.push(kept);
  });
  return reduced;
}

/**
 * Read a recorded citation list. Every list is validated as it is collected,
 * so anything unreadable is a corrupted record: it yields no citations rather
 * than an unchecked shape.
 */
export function parseCitations(value: unknown): AnswerCitation[] {
  const parsed = answerCitationsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** {@link parseCitations} for a stored JSON column. */
export function parseStoredCitations(value: string | null | undefined): AnswerCitation[] {
  if (!value) return [];
  try {
    return parseCitations(JSON.parse(value));
  } catch {
    return [];
  }
}

/**
 * The digest that binds a held candidate to what approval will release. An
 * answer without citations keeps the plain text digest, so a candidate held
 * before citations existed still verifies on approval.
 */
export function digestAnswerCandidate(
  answer: string,
  citations: readonly AnswerCitation[] = [],
): string {
  const material =
    citations.length === 0 ? answer : JSON.stringify({ v: 1, answer, citations: [...citations] });
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/** The citations rendered as text, for surfaces that show a reader plain text only. */
export function renderCitationsText(citations: readonly AnswerCitation[]): string {
  if (citations.length === 0) return "";
  const lines = ["Sources:"];
  citations.forEach((citation, index) => {
    const label = [citation.title ?? "Untitled", citation.sourceType, citation.timestamp]
      .filter(Boolean)
      .join(" · ");
    lines.push(`${index + 1}. ${label}`);
    if (citation.sourceUrl) lines.push(`   Link: ${citation.sourceUrl}`);
    if (citation.appUrl) lines.push(`   App link: ${citation.appUrl}`);
  });
  return lines.join("\n");
}

/**
 * A title is document text anyone could have written, such as an email
 * subject. Its line breaks and control characters become spaces, so a title
 * can neither fake further lines of a rendered citation list nor reach a
 * terminal as an escape sequence.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_OR_LINE_BREAK = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

function singleLine(value: string): string {
  return value.replace(CONTROL_OR_LINE_BREAK, " ").replace(/ {2,}/g, " ").trim();
}

/** Schemes a reader could be harmed by following, whatever the source meant by them. */
const UNSAFE_URL_SCHEMES = new Set(["javascript", "data", "vbscript", "file", "blob"]);

/**
 * A link is released only when it is one: an absolute URL with a scheme, no
 * whitespace or control characters, and no scheme that runs or embeds content
 * when followed. App schemes such as `messages:` stay, since a source's own
 * link is often one.
 */
function usableUrl(value: string | undefined): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CITATION_URL_CHARS) {
    return false;
  }
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  return scheme !== undefined && !UNSAFE_URL_SCHEMES.has(scheme);
}

function isoTimestamp(ms: number): string | undefined {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * The text the deterministic credential detector scans for one candidate: the
 * answer and every free-text citation field. A link can carry a token as
 * readily as prose can.
 */
export function credentialScanText(answer: string, citations: readonly AnswerCitation[]): string {
  const citationText = citations.flatMap((citation) =>
    [citation.title, citation.sourceUrl, citation.appUrl].filter(
      (value): value is string => typeof value === "string",
    ),
  );
  return [answer, ...citationText].join("\n");
}
