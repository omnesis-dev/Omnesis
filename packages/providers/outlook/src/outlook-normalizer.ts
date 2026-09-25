// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createLogger,
  computeContentHash,
  cleanPersonName,
  extractEmailsFromText,
  extractPhonesFromText,
  shouldExtractAttachment,
  resolveEffectiveMimeType,
  buildAttachmentDocument,
  formatAttachmentMarkers,
  htmlToMarkdown,
  deriveAttachmentStableId,
  isTransientSyncError,
} from "@omnesis/core";
import type {
  AttachmentInfo,
  AttachmentExtractionConfig,
  AttachmentExtractFn,
  ExtractionResult,
} from "@omnesis/core";
import type {
  DocumentInput,
  PersonMention,
  SourceId as SourceIdType,
  ProviderId as ProviderIdType,
} from "@omnesis/types";
import type { GraphClient } from "./graph-client.js";
import type {
  GraphAttachment,
  GraphAttachmentListResponse,
  GraphFileAttachment,
  GraphReferenceAttachment,
  GraphMessage,
  GraphRecipient,
} from "./outlook-types.js";

const FILE_ATTACHMENT_TYPE = "#microsoft.graph.fileAttachment";
const REFERENCE_ATTACHMENT_TYPE = "#microsoft.graph.referenceAttachment";

function isFileAttachment(a: GraphAttachment): a is GraphFileAttachment {
  return a["@odata.type"] === FILE_ATTACHMENT_TYPE;
}

function isReferenceAttachment(a: GraphAttachment): a is GraphReferenceAttachment {
  return a["@odata.type"] === REFERENCE_ATTACHMENT_TYPE;
}

const log = createLogger("source:outlook-email");

export interface NormalizerDeps {
  providerId: ProviderIdType;
  sourceId: SourceIdType;
  attachmentConfig: AttachmentExtractionConfig;
  extractAttachment?: AttachmentExtractFn;
  graph: GraphClient;
}

/**
 * Fetch the file + reference attachments for a Graph message. Drops
 * `itemAttachment` (forwarded Outlook items) — those are tracked
 * separately in #261. File attachments carry bytes and feed the
 * extraction pipeline; reference attachments are OneDrive/SharePoint
 * links and surface as link-only metadata in the parent (#262).
 */
export async function fetchAttachments(
  graph: GraphClient,
  messageId: string,
): Promise<{ files: GraphFileAttachment[]; references: GraphReferenceAttachment[] }> {
  const res = await graph.get<GraphAttachmentListResponse>(`/me/messages/${messageId}/attachments`);
  const files: GraphFileAttachment[] = [];
  const references: GraphReferenceAttachment[] = [];
  for (const a of res.value) {
    if (isFileAttachment(a)) files.push(a);
    else if (isReferenceAttachment(a)) references.push(a);
    // itemAttachment intentionally dropped here — see #261.
  }
  return { files, references };
}

export function computeRelevanceScore(msg: GraphMessage): number {
  let score = 0.5;
  if (msg.importance === "high") score += 0.15;
  if (msg.flag?.flagStatus === "flagged") score += 0.15;
  if (msg.categories && msg.categories.length > 0) score += 0.1;
  return Math.max(0, Math.min(1, score));
}

export async function normalizeMessage(
  msg: GraphMessage,
  deps: NormalizerDeps,
): Promise<DocumentInput[]> {
  if (msg.isDraft) return [];

  if (!msg.receivedDateTime) {
    log.debug(`Skipping partial delta message ${msg.id}: missing receivedDateTime`);
    return [];
  }

  const subject = msg.subject || "(no subject)";

  let body: string;
  if (!msg.body) {
    body = "";
  } else if (msg.body.contentType === "text") {
    body = msg.body.content ?? "";
  } else {
    body = htmlToMarkdown(msg.body.content ?? "");
  }

  const from = msg.from?.emailAddress;
  const toRecips = msg.toRecipients ?? [];
  const ccRecips = msg.ccRecipients ?? [];
  const bccRecips = msg.bccRecipients ?? [];

  const formatRecipient = (r: GraphRecipient) => {
    const addr = r.emailAddress;
    return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
  };

  // SECURITY CAVEAT: these identities come from the sender-claimed
  // `from`/`to`/`cc` addresses (Microsoft Graph) and attacker-controlled body
  // text. We don't inspect `internetMessageHeaders` for an aligned DKIM/DMARC
  // pass, so a spoofed sender is ingested as a normal mention. Treat as
  // UNVERIFIED — usable for search/graph completeness, but a retrieval-trust
  // gate must verify before crediting a person.
  const people: PersonMention[] = [];
  const seenEmails = new Set<string>();

  if (from?.address) {
    const email = from.address.toLowerCase();
    seenEmails.add(email);
    people.push({
      role: "sender",
      name: cleanPersonName(from.name),
      emails: [email],
    });
  }

  for (const recip of [...toRecips, ...ccRecips, ...bccRecips]) {
    const addr = recip.emailAddress;
    if (!addr?.address) continue;
    const email = addr.address.toLowerCase();
    if (seenEmails.has(email)) continue;
    seenEmails.add(email);
    people.push({
      role: "recipient",
      name: cleanPersonName(addr.name),
      emails: [email],
    });
  }

  const bodyEmails = extractEmailsFromText(body).filter((e) => !seenEmails.has(e));
  const bodyPhones = extractPhonesFromText(body);

  for (const email of bodyEmails) {
    people.push({ role: "mentioned", emails: [email] });
  }
  for (const phone of bodyPhones) {
    people.push({ role: "mentioned", phones: [phone], allowPersonCreation: false });
  }

  const relevanceScore = computeRelevanceScore(msg);

  const attachmentInfos: AttachmentInfo[] = [];
  // Note: no attachmentId field — child externalId derives from
  // (filename, size, mimeType, seq) via deriveAttachmentStableId, which is
  // stable across re-syncs (#268). Outlook's Graph attachment id is only
  // used inside fetchAttachments above for the GET call.
  const attachmentDocs: {
    filename: string;
    extractionResult: ExtractionResult;
    mimeType: string;
    sizeBytes: number;
  }[] = [];

  if (deps.attachmentConfig.enabled && deps.extractAttachment && msg.hasAttachments) {
    try {
      const { files: fileAttachments, references: referenceAttachments } = await fetchAttachments(
        deps.graph,
        msg.id,
      );

      // referenceAttachments — OneDrive / SharePoint links. No bytes to
      // extract; surface as link metadata so the user sees them and so the
      // link graph can resolve them once the OneDrive source ships (#263).
      for (const ref of referenceAttachments) {
        attachmentInfos.push({
          filename: ref.name,
          // Reference attachments often omit contentType — fall back to a
          // sensible placeholder so the panel still has something to render.
          mimeType: ref.contentType ?? "application/x-onedrive-reference",
          size: ref.size ?? null,
          extracted: false,
          reason: "reference-only",
          url: ref.sourceUrl,
        });
      }

      for (const att of fileAttachments) {
        // Recover the real type when the client sent a generic Content-Type
        // (a .pkpass mislabeled application/octet-stream is the common case).
        const contentType = resolveEffectiveMimeType(att.name, att.contentType);
        const check = shouldExtractAttachment(contentType, att.size, deps.attachmentConfig);
        if (!check.extract) {
          attachmentInfos.push({
            filename: att.name,
            mimeType: contentType,
            size: att.size,
            extracted: false,
            reason: check.reason,
          });
          continue;
        }

        try {
          const data = Buffer.from(att.contentBytes, "base64");
          const result = await deps.extractAttachment(new Uint8Array(data), contentType, {
            maxTextLength: deps.attachmentConfig.maxTextLength,
          });

          if (result?.noText) {
            attachmentInfos.push({
              filename: att.name,
              mimeType: contentType,
              size: att.size,
              extracted: false,
              reason: "no-text",
            });
          } else if (result) {
            attachmentInfos.push({
              filename: att.name,
              mimeType: contentType,
              size: att.size,
              extracted: true,
            });
            attachmentDocs.push({
              filename: att.name,
              extractionResult: result,
              mimeType: contentType,
              sizeBytes: att.size,
            });
          } else {
            attachmentInfos.push({
              filename: att.name,
              mimeType: contentType,
              size: att.size,
              extracted: false,
              reason: "extraction-failed",
            });
          }
        } catch (err) {
          // Transient extraction-backend blip → fail the page so it retries,
          // rather than recording a permanent extraction failure and advancing
          // the cursor past a file that would extract cleanly later (#680).
          if (isTransientSyncError(err)) throw err;
          log.warn(
            `Failed to extract attachment ${att.name} from ${msg.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          attachmentInfos.push({
            filename: att.name,
            mimeType: contentType,
            size: att.size,
            extracted: false,
            reason: "extraction-failed",
          });
        }
      }
    } catch (err) {
      // Don't let the outer attachment-fetch guard swallow a transient
      // extraction blip re-thrown from the inner loop above (#680).
      if (isTransientSyncError(err)) throw err;
      log.warn(
        `Failed to fetch attachments for ${msg.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let content = [
    `# ${subject}`,
    "",
    from ? `**From:** ${from.name ? `${from.name} <${from.address}>` : from.address}` : "",
    toRecips.length ? `**To:** ${toRecips.map(formatRecipient).join(", ")}` : "",
    ccRecips.length ? `**Cc:** ${ccRecips.map(formatRecipient).join(", ")}` : "",
    `**Date:** ${msg.receivedDateTime}`,
    "",
    "---",
    "",
    body,
  ]
    .filter(Boolean)
    .join("\n");

  if (attachmentInfos.length > 0) {
    content += formatAttachmentMarkers(attachmentInfos);
  }

  const contentHash = computeContentHash(content);

  const emailDoc: DocumentInput = {
    providerId: deps.providerId,
    sourceId: deps.sourceId,
    externalId: msg.id,
    title: subject,
    content,
    contentHash,
    metadata: {
      // No `appUrl`. Outlook's `ms-outlook://` scheme is registered on iOS but
      // addresses no item: every path form opens the app on the inbox,
      // discarding which message was tapped. `sourceUrl` opens the message in a
      // browser, which is less slick and actually arrives — the same reason
      // Gmail declares no `appUrl` for a scheme that can only compose.
      sourceUrl: msg.webLink,
      tags: msg.categories ?? [],
      documentType: "email",
      relevanceScore,
      people,
      extra: {
        threadId: msg.conversationId,
        conversationId: msg.conversationId,
        internetMessageId: msg.internetMessageId,
        importance: msg.importance,
        isRead: msg.isRead,
        hasAttachments: msg.hasAttachments,
        flagStatus: msg.flag?.flagStatus,
        ...(attachmentInfos.length > 0 ? { attachments: attachmentInfos } : {}),
      },
    },
    sourceCreatedAt: msg.receivedDateTime,
    sourceUpdatedAt: msg.lastModifiedDateTime ?? msg.receivedDateTime,
  };

  const result: DocumentInput[] = [emailDoc];
  const seqByBase = new Map<string, number>();
  for (const pending of attachmentDocs) {
    const baseId = deriveAttachmentStableId(pending.filename, pending.sizeBytes, pending.mimeType);
    const seq = seqByBase.get(baseId) ?? 0;
    seqByBase.set(baseId, seq + 1);
    result.push(
      buildAttachmentDocument(emailDoc, pending.filename, pending.extractionResult, {
        mimeType: pending.mimeType,
        sizeBytes: pending.sizeBytes,
        seq,
      }),
    );
  }

  return result;
}
