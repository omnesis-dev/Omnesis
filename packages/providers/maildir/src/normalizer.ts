// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One parsed message, and the folders and flags it has across the tree, as the
 * documents Omnesis stores: the email itself and one child per attachment
 * whose text was extracted.
 */

import {
  buildAttachmentDocument,
  computeContentHash,
  createLogger,
  deriveAttachmentStableId,
  extractSchemaOrgDatesFromHtml,
  formatAttachmentMarkers,
  htmlToMarkdown,
  isAutomatedSenderAddress,
  isAutoSubmittedGenerated,
  mailHeaderRelevancePenalty,
  mailPeopleMentions,
  resolveEffectiveMimeType,
  shouldExtractAttachment,
} from "@omnesis/core";
import { isTransientSyncError, SyncError } from "@omnesis/types";
import type {
  AttachmentExtractionConfig,
  AttachmentExtractFn,
  AttachmentInfo,
  ExtractionResult,
  MailAddress,
} from "@omnesis/core";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { EmittedAttachment } from "./index-store.js";
import type { ParsedAttachment, ParsedMessage } from "./message.js";

const log = createLogger("source:maildir");

const MAX_BODY_CHARS = 512 * 1024;
const MAX_PEOPLE_PER_MESSAGE = 1_000;
/** Addresses shown per header line; a message to a large list names the rest by count. */
const MAX_SHOWN_ADDRESSES = 50;
/** Thread references kept; the root is the first, and it is the one threading reads. */
const MAX_REFERENCES = 50;

/** Where a message lives in the tree, gathered over every copy of it. */
export interface MessagePlacement {
  key: string;
  /** The tags the folders holding a copy give it (see `folderTag`), sorted. */
  folders: string[];
  /** Whether any of those folders holds sent mail. */
  sent: boolean;
  /** Whether any copy is flagged (starred). */
  flagged: boolean;
  /** Whether any copy has been replied to. */
  answered: boolean;
  /** When the message was sent, from the header scan; the fallback when the parse finds no date. */
  dateMs: number;
}

export interface NormalizeContext {
  sourceId: SourceId;
  providerId: ProviderId;
  attachmentConfig: AttachmentExtractionConfig;
  extractAttachment?: AttachmentExtractFn;
}

export interface NormalizedMessage {
  documents: DocumentInput[];
  /** The attachments as emitted; each extracted one is a child document the snapshot names. */
  attachments: EmittedAttachment[];
}

function attachmentsEnabled(ctx: NormalizeContext): boolean {
  return ctx.attachmentConfig.enabled && ctx.extractAttachment !== undefined;
}

/** The child documents a message's emitted attachments made: one per extracted attachment. */
export function attachmentChildIds(
  key: string,
  attachments: readonly EmittedAttachment[],
): string[] {
  return attachments.filter((a) => a.info.extracted).map((a) => `${key}/att/${a.stableId}`);
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: "\u00a0",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  euro: "€",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  hellip: "…",
  ndash: "–",
  mdash: "—",
};

/**
 * Tidy the text a message is read as: HTML entities decoded, and runs of blank
 * lines cut to one. Mailers that build the plain-text part from HTML often
 * leave `&nbsp;` and `&#8217;` in it, and layout tables leave dozens of empty
 * lines; neither is text anyone wrote, and both get in the way of search.
 */
function tidyBody(text: string): string {
  const decoded = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#")) {
      const code =
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
  });
  return decoded.replace(/[ \t\u00a0]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

function countReplacements(text: string): number {
  return text.match(/\uFFFD/g)?.length ?? 0;
}

/** A plain-text part shorter than this may be a stand-in for the HTML one. */
const STUB_TEXT_CHARS = 400;

/** Whether a "plain text" part is really markup: several tags a person would not type. */
function looksLikeHtml(text: string): boolean {
  if (!/<(html|body|div|table|p|br|span|td)\b/i.test(text)) return false;
  return (text.match(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi)?.length ?? 0) >= 5;
}

/**
 * The text a message is read as.
 *
 * The plain-text part when it carries the message, since it is what the sender
 * wrote for reading as text. Two kinds of mail break that: a newsletter whose
 * plain part is a one-line stand-in ("view this email in your browser") while
 * the HTML holds everything, and a sender that put markup in the plain part.
 * The first is read from its HTML when that says much more; the second is
 * converted as the HTML it is.
 */
function messageBody(message: ParsedMessage): string {
  const text = message.text?.trim() ?? "";
  const html = () => (message.html ? htmlToMarkdown(message.html).trim() : "");
  if (!text) return html();
  // A text part whose charset was declared wrong decodes into replacement
  // characters; the HTML part of the same message is often labelled right.
  if (text.includes("\uFFFD") && message.html) {
    const fromHtml = html();
    if (countReplacements(fromHtml) < countReplacements(text)) return fromHtml;
  }
  if (looksLikeHtml(text)) return htmlToMarkdown(text).trim();
  if (text.length < STUB_TEXT_CHARS && message.html) {
    const fromHtml = html();
    if (fromHtml.length > Math.max(STUB_TEXT_CHARS, text.length * 3)) return fromHtml;
  }
  return message.text ?? "";
}

function formatAddresses(addresses: MailAddress[]): string[] {
  const shown = addresses
    .slice(0, MAX_SHOWN_ADDRESSES)
    .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address));
  const rest = addresses.length - shown.length;
  return rest > 0 ? [...shown, `and ${rest} more`] : shown;
}

function computeRelevanceScore(message: ParsedMessage, placement: MessagePlacement): number {
  let score = 0.5;
  if (placement.sent) score += 0.4;
  if (placement.flagged) score += 0.15;
  if (placement.folders.includes("IMPORTANT")) score += 0.15;
  score += mailHeaderRelevancePenalty(message);
  return Math.max(0, Math.min(1, score));
}

async function extractOne(
  attachment: ParsedAttachment,
  mimeType: string,
  ctx: NormalizeContext,
): Promise<{ info: AttachmentInfo; result?: ExtractionResult }> {
  const base = { filename: attachment.filename, mimeType, size: attachment.size };
  try {
    const result = await ctx.extractAttachment!(attachment.content, mimeType, {
      maxTextLength: ctx.attachmentConfig.maxTextLength,
    });
    if (result?.noText) return { info: { ...base, extracted: false, reason: "no-text" } };
    if (result) return { info: { ...base, extracted: true }, result };
    return { info: { ...base, extracted: false, reason: "extraction-failed" } };
  } catch (error) {
    // Extraction runs on the host; a typed or transient failure there is
    // infrastructure, and failing the page retries it. Recording it as this
    // attachment's permanent failure would never read it again.
    if (error instanceof SyncError || isTransientSyncError(error)) throw error;
    log.warn(
      `Failed to extract attachment ${attachment.filename}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { info: { ...base, extracted: false, reason: "extraction-failed" } };
  }
}

/**
 * Whether an attachment's extraction failed in a way a later try may not: the
 * extractor, or the OCR backend behind it, gave nothing back. A type or size
 * the settings exclude, or a picture that holds no text, is settled.
 */
export function isRetryableFailure(attachment: EmittedAttachment): boolean {
  return !attachment.info.extracted && attachment.info.reason === "extraction-failed";
}

/**
 * Build a message's documents.
 *
 * `reuse` is what was last emitted for its attachments, passed when the
 * settings that decide attachment documents have not changed since. Each
 * attachment that was settled keeps its marker and is not extracted again —
 * starring or archiving a message does not re-run text extraction or OCR on
 * what is attached to it, and child documents already made are left as they
 * are. An attachment whose extraction failed is tried again.
 */
export async function normalizeMessage(
  message: ParsedMessage,
  placement: MessagePlacement,
  ctx: NormalizeContext,
  reuse?: readonly EmittedAttachment[],
): Promise<NormalizedMessage> {
  const title = message.subject || "(no subject)";
  const rawBody = tidyBody(messageBody(message));
  const truncated = message.headersOnly || rawBody.length > MAX_BODY_CHARS;
  const body = rawBody.slice(0, MAX_BODY_CHARS);
  const date = message.date ?? new Date(placement.dateMs);
  const createdAt = date.toISOString();
  const automatedSender =
    isAutoSubmittedGenerated(message.autoSubmitted) ||
    isAutomatedSenderAddress(message.from[0]?.address ?? "");
  const schemaDates = message.html ? extractSchemaOrgDatesFromHtml(message.html) : {};
  const threadId = message.references[0] ?? message.inReplyTo ?? message.messageId ?? placement.key;
  const people = mailPeopleMentions(message, body, MAX_PEOPLE_PER_MESSAGE);

  const recorded: EmittedAttachment[] = [];
  const extracted: Array<{
    attachment: ParsedAttachment;
    mimeType: string;
    result: ExtractionResult;
  }> = [];
  const reused = new Map((reuse ?? []).map((a) => [a.stableId, a]));
  if (attachmentsEnabled(ctx)) {
    for (const attachment of message.attachments) {
      // The real type when the sender labelled the part generically.
      const mimeType = resolveEffectiveMimeType(attachment.filename, attachment.mimeType);
      const stableId = deriveAttachmentStableId(attachment.filename, attachment.size, mimeType);
      const previous = reused.get(stableId);
      if (previous && !isRetryableFailure(previous)) {
        recorded.push(previous);
        continue;
      }
      const check = shouldExtractAttachment(mimeType, attachment.size, ctx.attachmentConfig);
      if (!check.extract) {
        recorded.push({
          stableId,
          info: {
            filename: attachment.filename,
            mimeType,
            size: attachment.size,
            extracted: false,
            reason: check.reason,
          },
        });
        continue;
      }
      const { info, result } = await extractOne(attachment, mimeType, ctx);
      recorded.push({ stableId, info });
      if (result) extracted.push({ attachment, mimeType, result });
    }
  }
  const attachmentInfos: AttachmentInfo[] = recorded.map((a) => a.info);

  const from = formatAddresses(message.from);
  const to = formatAddresses(message.to);
  const cc = formatAddresses(message.cc);
  // Only absent header lines are dropped. The blank line before the rule is
  // kept: without it Markdown reads the line above `---` as a heading.
  const headerLines = [
    from.length ? `**From:** ${from.join(", ")}` : undefined,
    to.length ? `**To:** ${to.join(", ")}` : undefined,
    cc.length ? `**Cc:** ${cc.join(", ")}` : undefined,
    `**Date:** ${createdAt}`,
  ].filter((line): line is string => line !== undefined);
  let content = [`# ${title}`, "", ...headerLines, "", "---", "", body].join("\n");
  if (attachmentInfos.length > 0) content += formatAttachmentMarkers(attachmentInfos);

  const emailDoc: DocumentInput = {
    providerId: ctx.providerId,
    sourceId: ctx.sourceId,
    externalId: placement.key,
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      tags: placement.folders,
      documentType: "email",
      relevanceScore: computeRelevanceScore(message, placement),
      ...(message.listUnsubscribe ? { bulkMail: true } : {}),
      ...(automatedSender ? { automatedSender: true } : {}),
      ...(schemaDates.scheduledAt ? { scheduledAt: schemaDates.scheduledAt } : {}),
      ...(schemaDates.dueAt ? { dueAt: schemaDates.dueAt } : {}),
      people,
      extra: {
        internetMessageId: message.messageId,
        inReplyTo: message.inReplyTo,
        references:
          message.references.length > 0 ? message.references.slice(0, MAX_REFERENCES) : undefined,
        threadId,
        ...(placement.flagged ? { flagged: true } : {}),
        ...(placement.answered ? { answered: true } : {}),
        truncated,
        ...(attachmentInfos.length > 0 ? { attachments: attachmentInfos } : {}),
      },
    },
    sourceCreatedAt: createdAt,
    sourceUpdatedAt: createdAt,
  };
  return {
    documents: [
      emailDoc,
      ...extracted.map(({ attachment, mimeType, result }) =>
        buildAttachmentDocument(emailDoc, attachment.filename, result, {
          mimeType,
          sizeBytes: attachment.size,
        }),
      ),
    ],
    attachments: recorded,
  };
}
