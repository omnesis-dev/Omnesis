// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  sha256Hex,
  personMention,
  loadActiveUniverse,
  loadSourceFixtureJson,
} from "@omnesis/providers-synth-common";
import type { DocumentInput, PersonMention, ProviderId, SourceId } from "@omnesis/types";

interface EmailEntry {
  externalId: string;
  subject: string;
  from: string;
  fromEmail: string;
  to: string[];
  toEmails: string[];
  body: string;
  sentAt: string;
  threadId: string;
  folder: string;
}

let cached: EmailEntry[] | null = null;

export function loadEmails(): EmailEntry[] {
  if (cached) return cached;
  cached = loadSourceFixtureJson<EmailEntry[]>(
    loadActiveUniverse(),
    "outlook-email",
    "emails.json",
  );
  return cached;
}

export function mapEmail(
  e: EmailEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  const people: PersonMention[] = [
    { ...personMention(e.from, "sender"), emails: [e.fromEmail] },
    ...e.to.map(
      (ref, i): PersonMention => ({
        ...personMention(ref, "recipient"),
        emails: [e.toEmails[i]],
      }),
    ),
  ];
  return {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: e.externalId,
    title: e.subject,
    content: e.body,
    contentHash: sha256Hex(`${e.externalId}:${e.subject}:${e.body}`),
    metadata: {
      documentType: "email",
      people,
      extra: {
        threadId: e.threadId,
        folder: e.folder,
      },
    },
    sourceCreatedAt: e.sentAt,
    sourceUpdatedAt: e.sentAt,
  };
}
