// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  buildAttachmentDocument,
  deriveAttachmentStableId,
  formatAttachmentMarkers,
  resolveAttachmentConfig,
  shouldExtractAttachment,
  type AttachmentExtractFn,
  type AttachmentExtractionConfig,
  type AttachmentInfo,
  type ExtractionResult,
} from "@omnesis/core";
import {
  loadBinaryFixtureAssets,
  validateBinaryFixtureAssets,
  loadActiveUniverse,
  sha256Hex,
} from "@omnesis/providers-synth-common";
import {
  isTransientSyncError,
  type DocumentInput,
  type ProviderId,
  type SourceId,
} from "@omnesis/types";
import { mapEmail, type EmailEntry, type GmailBinaryAttachment } from "./fixtures.js";

export interface GmailFixtureExtraction {
  universeDir?: string;
  extractAttachment?: AttachmentExtractFn;
  attachmentConfig?: AttachmentExtractionConfig;
}

export function hasBinaryAttachments(entry: EmailEntry): boolean {
  return (entry.attachments ?? []).some((attachment) => "assetPath" in attachment);
}

/** Binary fixtures use the same injected byte extractor as the production Gmail source. */
export async function mapEmailWithAssets(
  entry: EmailEntry,
  context: { sourceId: SourceId; providerId: ProviderId },
  options: GmailFixtureExtraction,
): Promise<DocumentInput | DocumentInput[]> {
  if (!hasBinaryAttachments(entry)) return mapEmail(entry, context);
  const attachments = entry.attachments ?? [];
  if (attachments.length > 20) throw new Error("Gmail fixture attachments exceed 20 parts");
  const binary = attachments.filter(
    (attachment): attachment is GmailBinaryAttachment => "assetPath" in attachment,
  );
  if (binary.some((attachment) => "extractedText" in attachment))
    throw new Error("Binary Gmail fixtures cannot declare pre-extracted text");
  validateBinaryFixtureAssets(binary);
  const config =
    options.attachmentConfig ?? resolveAttachmentConfig(undefined, { defaultEnabled: true });
  // Reading is bounded independently of the extraction policy, and no asset outside
  // the universe can reach a host service. Disabled extraction does not open files.
  const assets = config.enabled
    ? loadBinaryFixtureAssets(binary, options.universeDir ?? loadActiveUniverse().dir)
    : [];
  let assetIndex = 0;
  const parent = mapEmail({ ...entry, attachments: [] }, context) as DocumentInput;
  const infos: AttachmentInfo[] = [];
  const children: DocumentInput[] = [];
  const sequences = new Map<string, number>();
  for (const attachment of attachments) {
    const asset = "assetPath" in attachment ? assets[assetIndex++] : undefined;
    const size = asset?.content.byteLength ?? attachment.sizeBytes ?? null;
    const mimeType = attachment.mimeType;
    const base = { filename: attachment.filename, mimeType, size };
    const baseId = deriveAttachmentStableId(attachment.filename, size, mimeType);
    const seq = sequences.get(baseId) ?? 0;
    sequences.set(baseId, seq + 1);
    if (!config.enabled) {
      infos.push({ ...base, extracted: false });
      continue;
    }
    const check = shouldExtractAttachment(mimeType, size, config);
    if (!check.extract) {
      infos.push({ ...base, extracted: false, reason: check.reason });
      continue;
    }
    let result: ExtractionResult | null;
    if ("assetPath" in attachment) {
      if (!options.extractAttachment) {
        infos.push({ ...base, extracted: false, reason: "extraction-failed" });
        continue;
      }
      try {
        result = await options.extractAttachment(asset!.content, mimeType, {
          maxTextLength: config.maxTextLength,
        });
      } catch (error) {
        if (isTransientSyncError(error)) throw error;
        infos.push({ ...base, extracted: false, reason: "extraction-failed" });
        continue;
      }
    } else {
      result = { text: attachment.extractedText, truncated: false };
    }
    if (!result || result.noText) {
      infos.push({
        ...base,
        extracted: false,
        reason: result?.noText ? "no-text" : "extraction-failed",
      });
      continue;
    }
    infos.push({ ...base, extracted: true });
    children.push(
      buildAttachmentDocument(parent, attachment.filename, result, {
        mimeType,
        sizeBytes: size,
        seq,
      }),
    );
  }
  parent.content += formatAttachmentMarkers(infos);
  parent.contentHash = sha256Hex(`${entry.externalId}:${entry.subject}:${parent.content}`);
  parent.metadata.extra = { ...parent.metadata.extra, attachments: infos };
  return [parent, ...children];
}
