// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  sha256Hex,
  personMention,
  loadActiveUniverse,
  loadSourceFixtureJson,
} from "@omnesis/providers-synth-common";
import {
  buildAttachmentDocument,
  formatAttachmentMarkers,
  type AttachmentInfo,
} from "@omnesis/core";
import {
  type DocumentInput,
  type PersonMention,
  type ProviderId,
  type SourceId,
} from "@omnesis/types";

interface ChatMessage {
  from: string;
  at: string;
  text: string;
}

interface ChatAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  extractedText: string;
}

interface DailyChatEntry {
  externalId: string;
  chatId: string;
  chatTitle: string;
  date: string;
  counterparty: string;
  messages: ChatMessage[];
  attachments?: ChatAttachment[];
}

let cached: DailyChatEntry[] | null = null;

export function loadChats(): DailyChatEntry[] {
  if (cached) return cached;
  cached = loadSourceFixtureJson<DailyChatEntry[]>(
    loadActiveUniverse(),
    "whatsapp-messages",
    "messages.json",
  );
  return cached;
}

export function mapChat(
  e: DailyChatEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput | DocumentInput[] {
  const lines = e.messages.map((m) => {
    const speaker = m.from === "self" ? "You" : e.chatTitle;
    return `[${m.at.slice(11, 16)}] ${speaker}: ${m.text}`;
  });
  let content = `# ${e.chatTitle} — ${e.date}\n\n${lines.join("\n")}`;
  const people: PersonMention[] = [
    personMention("self", "participant"),
    personMention(e.counterparty, "participant"),
  ];
  const firstAt = e.messages[0]?.at ?? `${e.date}T00:00:00Z`;
  const lastAt = e.messages[e.messages.length - 1]?.at ?? firstAt;

  const attachments = e.attachments ?? [];
  const attachmentInfos: AttachmentInfo[] = attachments.map((a) => ({
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.sizeBytes,
    extracted: true,
  }));
  if (attachmentInfos.length > 0) {
    content += formatAttachmentMarkers(attachmentInfos);
  }

  const parentDoc: DocumentInput = {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: e.externalId,
    title: `${e.chatTitle} — ${e.date}`,
    content,
    contentHash: sha256Hex(`${e.externalId}:${content}`),
    metadata: {
      documentType: "conversation",
      people,
      extra: {
        chatId: e.chatId,
        date: e.date,
        messageCount: e.messages.length,
        ...(attachmentInfos.length > 0 ? { attachments: attachmentInfos } : {}),
      },
    },
    sourceCreatedAt: firstAt,
    sourceUpdatedAt: lastAt,
  };

  if (attachments.length === 0) return parentDoc;

  const attachmentDocs = attachments.map((att) =>
    buildAttachmentDocument(
      parentDoc,
      att.filename,
      { text: att.extractedText, truncated: false },
      {
        mimeType: att.mimeType,
        sizeBytes: att.sizeBytes,
      },
    ),
  );
  return [parentDoc, ...attachmentDocs];
}
