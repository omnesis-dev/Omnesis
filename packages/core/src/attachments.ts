// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash } from "./utils.js";
import { extractEmailsAndPhonesFromText } from "./people-utils.js";
import { personIdentifiers } from "./document.js";
import type { DocumentInput, PersonMention } from "./document.js";

/**
 * Information about a single attachment on an email.
 *
 * `size` is `null` when the source advertised the attachment but did not
 * report a byte count. We surface it (and skip extraction with reason
 * `size-unknown`) rather than guessing — see `shouldExtractAttachment`.
 *
 * `url` is set for reference-style attachments (Outlook's OneDrive /
 * SharePoint link attachments). The bytes never travel over
 * the wire; we surface the link target as metadata so the user can see
 * the attachment exists, and so the link graph can resolve it to an
 * indexed doc once the corresponding source is added.
 */
export interface AttachmentInfo {
  filename: string;
  mimeType: string;
  size: number | null;
  extracted: boolean;
  reason?:
    | "type-excluded"
    | "size-unknown"
    | "too-large"
    | "encrypted"
    | "no-text"
    | "extraction-failed"
    | "download-failed"
    // Terminal: the media is gone from the source (e.g. evicted from the
    // WhatsApp CDN and no device re-uploaded it) — distinct from a `download-
    // failed` blip, which is retriable.
    | "unavailable"
    | "reference-only";
  url?: string;
}

/**
 * Resolved attachment extraction configuration with defaults applied.
 */
export interface AttachmentExtractionConfig {
  enabled: boolean;
  maxSizeBytes: number;
  allowedTypes: string[];
  maxTextLength: number;
}

/**
 * Result of extracting text from an attachment.
 *
 * `extra` lets type-aware extractors surface structured metadata that
 * downstream consumers may want to act on. Calendar extraction exposes RFC
 * 5545 `UID` values for cross-source links, while partial PDF extraction marks
 * sparse pages whose OCR enrichment still needs retrying.
 */
export interface ExtractionResult {
  text: string;
  pages?: number;
  truncated: boolean;
  /** Extraction completed successfully, but the attachment contained no text. */
  noText?: true;
  extra?: Record<string, unknown> & {
    /** Native PDF text was preserved, but one or more sparse pages still need OCR. */
    ocrIncomplete?: true;
  };
}

/** Default max attachment size: 25MB */
export const DEFAULT_MAX_SIZE_BYTES = 26_214_400;

/** Default allowed MIME types */
export const DEFAULT_ATTACHMENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.ms-excel",
  "application/x-msexcel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/rtf",
  "text/rtf",
  "text/plain",
  "text/csv",
  "text/html",
  "text/markdown",
  "application/json",
  "text/calendar",
  "message/rfc822",
  // Apple Wallet passes — parsed into searchable text in the attachment
  // extractor (boarding passes, event tickets, loyalty cards).
  "application/vnd.apple.pkpass",
  "application/vnd.apple.pkpasses",
];

/**
 * Image MIME types eligible for OCR. Part of the default allowed-types set
 * (see `resolveAttachmentConfig`) since OCR graduated out of experimental, so a
 * source with attachment extraction enabled downloads images and runs them
 * through OCR. When no OCR backend is assigned the extractor returns null and
 * the image is recorded as extraction-failed (retried on a later resync). A
 * successful OCR response with no recognized text is terminal and recorded as
 * no-text. PDFs are already in the default set; the scanned-PDF OCR fallback
 * lives inside the PDF extractor.
 */
const OCR_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/tiff",
  "image/bmp",
  "image/heic",
  "image/heif",
];

/**
 * Audio MIME types eligible for speech-to-text. Added to the allowed-types set
 * only when a document source's `resolveAttachmentConfig({ includeAudioTypes })`
 * opts in — which the collector does for non-conversational sources (email)
 * when the `stt` feature is on (see `source-instantiator.ts`). With STT off, or
 * for a conversation source (WhatsApp, iMessage — those transcribe audio inline
 * rather than as a child doc), no audio is ever downloaded for extraction, so
 * behavior is byte-for-byte the prior default.
 */
export const STT_AUDIO_TYPES = [
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/amr",
  "audio/x-caf",
  "audio/wav",
  "audio/aac",
  "audio/opus",
];

/** Default max extracted text length: 500KB */
export const DEFAULT_MAX_TEXT_LENGTH = 512_000;

/**
 * Filename-extension → canonical MIME type, for the attachment types the
 * pipeline can extract. Used only to recover the real type when a source
 * delivers a generic / empty Content-Type (see `resolveEffectiveMimeType`).
 */
const EXTENSION_MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  ics: "text/calendar",
  eml: "message/rfc822",
  // Apple Wallet passes — routinely delivered as application/octet-stream by
  // Gmail and Outlook, so extension recovery is what makes them extractable.
  pkpass: "application/vnd.apple.pkpass",
  pkpasses: "application/vnd.apple.pkpasses",
  // Images (OCR'd when a backend is assigned).
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  tiff: "image/tiff",
  tif: "image/tiff",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
};

/**
 * MIME types that carry no real information about the payload — a source that
 * reports one of these is effectively saying "unknown binary". Only for these
 * do we fall back to the filename extension. `application/zip` variants are
 * included because a `.pkpass` (itself a zip) and OOXML docs are sometimes
 * mislabeled that way.
 */
const GENERIC_MIME_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/zip",
  "application/x-zip-compressed",
]);

/**
 * Resolve the effective MIME type of an attachment from its reported type and
 * filename.
 *
 * Mail servers and clients routinely deliver an attachment with a generic
 * `application/octet-stream` (or empty) Content-Type instead of its real type —
 * Apple Wallet passes (`.pkpass`) arrive this way from both Gmail and Outlook,
 * and PDFs / Office documents sometimes do too. When the reported type is
 * generic we recover the real type from the filename extension so the
 * attachment still routes to the right extractor; a specific reported type is
 * always trusted as-is. Only extensions that map to a type the pipeline can
 * extract are recovered — anything else keeps its reported type, so genuinely
 * unknown binaries stay excluded by the allow-list.
 */
export function resolveEffectiveMimeType(
  filename: string | null | undefined,
  mimeType: string | null | undefined,
): string {
  const reported = mimeType ?? "";
  const base = reported.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!GENERIC_MIME_TYPES.has(base)) return reported;
  const dot = filename ? filename.lastIndexOf(".") : -1;
  if (filename && dot >= 0) {
    const ext = filename.slice(dot + 1).toLowerCase();
    // `Object.hasOwn`, not a truthiness check: the extension comes from an
    // attacker-controlled filename, and a plain `EXTENSION_MIME_TYPES[ext]`
    // lookup for an inherited key (`constructor`, `__proto__`, `toString`, …)
    // returns a truthy non-string from the prototype chain.
    if (Object.hasOwn(EXTENSION_MIME_TYPES, ext)) return EXTENSION_MIME_TYPES[ext];
  }
  return reported;
}

/**
 * MIME type → the name a person would use for that kind of file.
 *
 * A file's type is rendered into the indexed body, where the raw MIME string
 * is noise: it dilutes BM25, reads as machine output in a search snippet, and
 * means "Word documents" as a natural-language filter matches whichever source
 * happened to translate it. The vocabulary is the everyday name, not the
 * extension — "Word document", not "DOCX".
 *
 * Only formats whose name is the same wherever the file came from live here.
 * A provider's own document types are its business: it layers them on top by
 * consulting its own map first and falling back to this one.
 */
const FILE_KIND_NAMES: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word document",
  "application/msword": "Word document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel spreadsheet",
  "application/vnd.ms-excel": "Excel spreadsheet",
  "application/x-msexcel": "Excel spreadsheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "PowerPoint presentation",
  "application/vnd.ms-powerpoint": "PowerPoint presentation",
  "application/vnd.oasis.opendocument.text": "OpenDocument text",
  "application/vnd.oasis.opendocument.spreadsheet": "OpenDocument spreadsheet",
  "application/vnd.oasis.opendocument.presentation": "OpenDocument presentation",
  "application/rtf": "RTF document",
  "text/rtf": "RTF document",
  "message/rfc822": "Email message",
  "text/csv": "CSV",
  "text/plain": "Text file",
  "text/markdown": "Markdown",
  "application/json": "JSON",
  "application/zip": "Zip archive",
};

/**
 * The everyday name for a MIME type, falling back to the type itself when
 * there is none — an unknown type is still more useful rendered than dropped.
 * `overrides` lets a provider name its own formats (Google's `Google Doc`)
 * without teaching core about that provider.
 */
export function fileKindName(mimeType: string, overrides?: Record<string, string>): string {
  return overrides?.[mimeType] ?? FILE_KIND_NAMES[mimeType] ?? mimeType;
}

/**
 * Attachment extraction function signature.
 * Implemented in collector (wraps unpdf), injected into sources.
 */
export type AttachmentExtractFn = (
  data: Uint8Array,
  mimeType: string,
  opts?: { maxTextLength?: number },
) => Promise<ExtractionResult | null>;

/**
 * Resolve attachment config from source config fields, applying defaults.
 *
 * `defaults.defaultEnabled` lets sources that natively support attachment
 * extraction (gmail, outlook) opt into "on by default" — operators can still
 * explicitly set `extractAttachments: false` to opt out, since the explicit
 * boolean wins over the default.
 *
 * `defaults.includeAudioTypes` adds audio MIME types to the allow-set so a
 * document source (email) downloads audio attachments and transcribes them
 * into a child doc. The collector sets it for non-conversational sources when
 * the `stt` feature is on (see `source-instantiator.ts`); conversation sources
 * leave it off and transcribe inline instead.
 */
export function resolveAttachmentConfig(
  sourceConfig?: {
    extractAttachments?: boolean;
    attachmentMaxSizeBytes?: number;
    attachmentTypes?: string[];
    attachmentMaxTextLength?: number;
  },
  defaults?: { defaultEnabled?: boolean; includeAudioTypes?: boolean },
): AttachmentExtractionConfig {
  // Image types are in the default allow-set so image / scanned attachments get
  // downloaded and OCR'd. Audio types join when the caller opts in via
  // `includeAudioTypes` (a document source whose audio attachments should be
  // transcribed). An explicit per-source `attachmentTypes` always wins (the
  // operator opted into an exact set).
  const defaultTypes = [
    ...DEFAULT_ATTACHMENT_TYPES,
    ...OCR_IMAGE_TYPES,
    ...(defaults?.includeAudioTypes ? STT_AUDIO_TYPES : []),
  ];

  return {
    enabled: sourceConfig?.extractAttachments ?? defaults?.defaultEnabled ?? false,
    maxSizeBytes: sourceConfig?.attachmentMaxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES,
    allowedTypes: sourceConfig?.attachmentTypes ?? defaultTypes,
    maxTextLength: sourceConfig?.attachmentMaxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
  };
}

/**
 * Check whether an attachment should be extracted based on config.
 *
 * `size` is `null` when the source did not report a byte count. We err on
 * the side of caution and skip rather than download something that could be
 * arbitrarily large — see `AttachmentInfo.size`.
 */
export function shouldExtractAttachment(
  mimeType: string,
  size: number | null,
  config: AttachmentExtractionConfig,
): { extract: boolean; reason?: AttachmentInfo["reason"] } {
  const base = baseMimeType(mimeType);
  const allowed = config.allowedTypes.some((type) => baseMimeType(type) === base);
  if (!allowed) {
    return { extract: false, reason: "type-excluded" };
  }
  if (size === null) {
    return { extract: false, reason: "size-unknown" };
  }
  if (size > config.maxSizeBytes) {
    return { extract: false, reason: "too-large" };
  }
  return { extract: true };
}

function baseMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType;
}

/**
 * Derive a stable, content-addressable identifier for an attachment.
 *
 * The id hashes `(filename, sizeBytes, mimeType)` — properties that don't
 * change across re-syncs of the same parent message. This is intentional:
 * Gmail's `payload.parts[].body.attachmentId` is **not** stable (the server
 * mints a fresh one on each `messages.get`), and using it in the externalId
 * scheme meant every parent re-fetch created a new attachment doc
 * with the same content_hash, leaking duplicates over time.
 *
 * Ties — two attachments with identical (filename, size, mimeType) in the
 * same parent, e.g. two scans saved with the same auto-generated name — are
 * disambiguated by the `seq` parameter (0 for the first occurrence, 1 for
 * the second, etc.).
 *
 * **Caller contract — `seq` stability across re-syncs.** The source MUST
 * pick `seq` from a deterministic, position-independent ordering of the
 * parent's attachment list. The recommended way to do this is via
 * `assignAttachmentSeqs` below, which sorts by `(filename, size, mimeType,
 * tieBreaker)` and assigns 0/1/2 within each tie group. Sources that
 * iterate Map / Object insertion order get the right answer in modern V8
 * by accident — but that's a contract you can't see and a refactor can
 * break. Use `assignAttachmentSeqs` so the assumption is encoded in code.
 *
 * Output length: 16 hex chars from a SHA-256 prefix (64 bits of entropy →
 * collision risk is negligible within a single parent's attachment list,
 * which has at most ~50 entries even for the largest emails).
 */
export function deriveAttachmentStableId(
  filename: string,
  sizeBytes: number | null,
  mimeType: string,
  seq: number = 0,
): string {
  const base = computeContentHash(`${filename}\n${sizeBytes ?? "unknown"}\n${mimeType}`).slice(
    0,
    16,
  );
  return seq === 0 ? base : `${base}:${seq}`;
}

/**
 * Sort a parent's attachment list and assign stable `seq` values inside
 * each `(filename, sizeBytes, mimeType)` tie group, so
 * `deriveAttachmentStableId` produces identical ids across re-syncs
 * regardless of source-side iteration order.
 *
 * Two attachments with the same `(filename, sizeBytes, mimeType)` are
 * intrinsically ambiguous, so a `tieBreaker` callback runs only inside
 * such a group — pass something that's stable per attachment (e.g. a
 * content-hash slice, the source's own attachment id, or even a
 * provider-specific fingerprint). Returning the same value for two
 * tied attachments keeps the existing insertion-order assignment;
 * returning distinct values disambiguates.
 *
 * Returns the input items wrapped with their assigned `seq`. The source
 * is expected to feed `seq` into `deriveAttachmentStableId` /
 * `buildAttachmentDocument`.
 */
export function assignAttachmentSeqs<T>(
  items: ReadonlyArray<T>,
  pick: (item: T) => { filename: string; sizeBytes: number | null; mimeType: string },
  tieBreaker?: (item: T) => string,
): Array<{ item: T; seq: number }> {
  const sorted = [...items].sort((a, b) => {
    const ka = pick(a);
    const kb = pick(b);
    if (ka.filename !== kb.filename) return ka.filename < kb.filename ? -1 : 1;
    const sa = ka.sizeBytes ?? -1;
    const sb = kb.sizeBytes ?? -1;
    if (sa !== sb) return sa - sb;
    if (ka.mimeType !== kb.mimeType) return ka.mimeType < kb.mimeType ? -1 : 1;
    if (tieBreaker) {
      const ta = tieBreaker(a);
      const tb = tieBreaker(b);
      if (ta !== tb) return ta < tb ? -1 : 1;
    }
    return 0;
  });
  const seqByBase = new Map<string, number>();
  return sorted.map((item) => {
    const k = pick(item);
    const baseKey = `${k.filename}\n${k.sizeBytes ?? "unknown"}\n${k.mimeType}`;
    const seq = seqByBase.get(baseKey) ?? 0;
    seqByBase.set(baseKey, seq + 1);
    return { item, seq };
  });
}

/**
 * Below this many letter characters, an extraction is judged on its token
 * count rather than assumed substantial. Scripts that don't space their words
 * (CJK) produce one long token, so a dense body of such text must never be
 * mistaken for a one-word logo.
 */
const SUBSTANTIAL_LETTER_COUNT = 30;

/**
 * Minimum word-like tokens before a digit-less extraction counts as content.
 * Deliberately low: the failure this predicate must never produce is a real
 * document the agent never reacts to, and decorative-image OCR reliably lands
 * at one or two tokens. Three bare words already buys the benefit of the doubt.
 */
const MIN_CONTENT_TOKENS = 3;

/**
 * Whether an extraction produced nothing worth reasoning about on its own —
 * the text-side equivalent of a camera photo with no text, caption or labels.
 *
 * The case this exists for is the decorative image: logos and social icons in
 * an email signature, OCR'd down to a few stray characters. They arrive with
 * every message from a given correspondent, and each one is otherwise a
 * perfectly ordinary attachment document.
 *
 * "Nothing worth reasoning about" is deliberately narrow, because the cost of
 * a false positive is a real document the agent never reacts to:
 *
 *   - any digit, `@`, or URL means content — an amount, a date, a reference
 *     number, an address. `Invoice 4417 due 2026-08-30` is short but is the
 *     whole point of indexing attachments;
 *   - a substantial quantity of letters means content regardless of how it
 *     tokenizes, which is what keeps unspaced scripts out of this branch;
 *   - only what survives both — a handful of bare words — is trivial.
 *
 * A trivial extraction is still ingested, indexed, searchable and linked. The
 * marker only tells the background agent's wake heuristics not to spend a
 * reasoning run on this document's own arrival; the message carrying it is a
 * document in its own right and wakes on its own merits.
 */
export function isTrivialExtraction(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (/[0-9@]/.test(trimmed)) return false;
  if (/https?:\/\//i.test(trimmed)) return false;
  const letters = trimmed.match(/\p{L}/gu);
  if (letters !== null && letters.length >= SUBSTANTIAL_LETTER_COUNT) return false;
  const tokens = trimmed.match(/\p{L}{2,}/gu);
  return (tokens?.length ?? 0) < MIN_CONTENT_TOKENS;
}

/**
 * Build a DocumentInput for an extracted attachment.
 *
 * The externalId is derived from `(filename, sizeBytes, mimeType, seq)` via
 * `deriveAttachmentStableId` — see that helper for the rationale on why we
 * intentionally do **not** use Gmail/Outlook/iMessage/WhatsApp's own
 * attachment identifiers (they aren't all stable across sync runs).
 *
 * An attachment whose extraction is trivial (see {@link isTrivialExtraction})
 * carries the generic `lowSignal` marker, so shared consumers can skip it
 * without branching on a source name or a MIME type.
 *
 * Timestamps default to the parent's, which is right when the parent is a
 * single dated item — one email carries one send time, and its attachments
 * were sent with it. It is wrong when the parent aggregates many dated items:
 * a chat day-document spans a whole day, and inheriting its bounds collapses
 * every attachment sent that day onto the day's first message. Sources whose
 * parent is an aggregate pass `occurredAt` — the time of the individual
 * message that carried this file — so ordering within the day survives.
 */
export function buildAttachmentDocument(
  parentDoc: DocumentInput,
  filename: string,
  extractionResult: ExtractionResult,
  meta: {
    mimeType: string;
    sizeBytes: number | null;
    seq?: number;
    /**
     * ISO instant this attachment was actually sent, overriding the parent's
     * timestamps. Both `sourceCreatedAt` and `sourceUpdatedAt` take it: a sent
     * file is not edited afterwards, so its two timestamps are the same
     * instant, and pinning the update time stops every attachment in a chat
     * day from being rewritten each time a later message extends that day.
     */
    occurredAt?: string;
  },
): DocumentInput {
  const content = extractionResult.text;
  const contentHash = computeContentHash(content);
  const stableId = deriveAttachmentStableId(filename, meta.sizeBytes, meta.mimeType, meta.seq ?? 0);

  const people = derivePeopleForAttachment(parentDoc, content);

  return {
    providerId: parentDoc.providerId,
    sourceId: parentDoc.sourceId,
    externalId: `${parentDoc.externalId}/att/${stableId}`,
    // A child lives in the store its parent came from — the mailbox, the chat,
    // the notebook. Inherited rather than passed in, so a source that adopts
    // partitions gets its attachments covered by the same claim as the message
    // that carried them, instead of stranding them in a partition nobody names.
    partitionKey: parentDoc.partitionKey,
    title: filename,
    content,
    contentHash,
    // For attachment docs `content` IS the raw extracted text — no wrapping
    // — so the rendered hash and the cross-source dedup hash are equal.
    // Drive/Notion/etc. wrap, so this projection lets the dedup link work
    // across sources regardless of per-provider rendering choices.
    extractedContentHash: contentHash,
    metadata: {
      sourceUrl: parentDoc.metadata.sourceUrl,
      appUrl: parentDoc.metadata.appUrl,
      documentType: "attachment",
      people,
      // Omitted rather than `false` when the extraction has content, matching
      // the marker's contract.
      ...(isTrivialExtraction(content) ? { lowSignal: true } : {}),
      extra: {
        // Extractor-emitted extras first (e.g. iCalUIDs from the ICS
        // extractor); standard keys below override on collision so an
        // extractor can't accidentally clobber parentExternalId etc.
        ...(extractionResult.extra ?? {}),
        parentExternalId: parentDoc.externalId,
        originalFilename: filename,
        mimeType: meta.mimeType,
        sizeBytes: meta.sizeBytes,
        pages: extractionResult.pages,
        truncated: extractionResult.truncated,
      },
    },
    sourceCreatedAt: meta.occurredAt ?? parentDoc.sourceCreatedAt,
    sourceUpdatedAt: meta.occurredAt ?? parentDoc.sourceUpdatedAt,
  };
}

/**
 * Build the people array for an attachment doc.
 *
 * The default-inherit-everything model was wrong: an email's `mentioned`
 * people are scoped to that email's body — they have nothing to do with
 * an unrelated PDF attached to the same email. Inheriting them polluted
 * attachment docs with unrelated person associations and inflated each
 * mentioned person's apparent doc count.
 *
 * The correct model:
 *  - Inherit non-mention roles (sender, recipient, attendee, owner, etc.)
 *    from the parent — those people genuinely sent / received the
 *    attachment along with the parent message.
 *  - Re-extract mentions from the attachment's *own* extracted text. A
 *    PDF that contains "contact alice@example.com for details" gets
 *    alice as a mention; the same PDF attached to an email mentioning
 *    bob@example.com in the body does NOT get bob.
 *
 * Dedupe vs the inherited set so we don't list the parent's sender as a
 * "mentioned" on the attachment when their email also happens to appear
 * in the attachment's content (signature blocks, etc.).
 */
function derivePeopleForAttachment(
  parentDoc: DocumentInput,
  extractedText: string,
): PersonMention[] | undefined {
  const inherited = (parentDoc.metadata.people ?? []).filter((p) => p.role !== "mentioned");

  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();
  for (const p of inherited) {
    // Through the one reader, so a parent that names its identifiers by kind
    // is deduped against as well as one using the older arrays — otherwise an
    // attachment re-adds the addresses its parent already carries.
    for (const { kind, value } of personIdentifiers(p)) {
      if (kind === "email") seenEmails.add(value.toLowerCase());
      else if (kind === "phone") seenPhones.add(value);
    }
  }

  const newMentions: PersonMention[] = [];
  if (extractedText) {
    // Single unescape pass — pre-fix this code ran the Turndown-unescape
    // through both extractors, allocating ~2x the attachment text.
    const { emails, phones } = extractEmailsAndPhonesFromText(extractedText);
    for (const email of emails) {
      const lower = email.toLowerCase();
      if (seenEmails.has(lower)) continue;
      seenEmails.add(lower);
      newMentions.push({ role: "mentioned", emails: [email] });
    }
    for (const phone of phones) {
      if (seenPhones.has(phone)) continue;
      seenPhones.add(phone);
      newMentions.push({ role: "mentioned", phones: [phone], allowPersonCreation: false });
    }
  }

  const all = [...inherited, ...newMentions];
  return all.length > 0 ? all : undefined;
}

/**
 * Format the attachment markers string to append to parent email content.
 */
export function formatAttachmentMarkers(attachments: AttachmentInfo[]): string {
  if (attachments.length === 0) return "";

  const parts = attachments.map((a) => {
    const sizeStr = formatSize(a.size);
    const typeLabel = mimeTypeLabel(a.mimeType);
    return `${a.filename} (${typeLabel}, ${sizeStr})`;
  });

  return `\n---\n**Attachments:** ${parts.join(", ")}`;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "unknown size";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function mimeTypeLabel(mimeType: string): string {
  const map: Record<string, string> = {
    "application/pdf": "PDF",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PPTX",
    "application/msword": "DOC",
    "application/vnd.ms-excel": "XLS",
    "application/x-msexcel": "XLS",
    "application/vnd.ms-powerpoint": "PPT",
    "application/vnd.oasis.opendocument.text": "ODT",
    "application/vnd.oasis.opendocument.spreadsheet": "ODS",
    "application/vnd.oasis.opendocument.presentation": "ODP",
    "application/rtf": "RTF",
    "text/rtf": "RTF",
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/gif": "GIF",
    "image/webp": "WebP",
    "image/tiff": "TIFF",
    "image/bmp": "BMP",
    "image/heic": "HEIC",
    "image/heif": "HEIF",
    "application/zip": "ZIP",
    "text/plain": "Text",
    "text/csv": "CSV",
    "text/html": "HTML",
    "text/markdown": "Markdown",
    "text/calendar": "Calendar",
    "application/json": "JSON",
    "message/rfc822": "Email",
    "application/vnd.ms-outlook": "MSG",
  };
  return map[mimeType] ?? mimeType.split("/").pop()?.toUpperCase() ?? mimeType;
}
