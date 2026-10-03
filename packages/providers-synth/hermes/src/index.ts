// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import realSource from "@omnesis/provider-hermes";
import { defineSource } from "@omnesis/source-sdk";
import { conversationExternalId, localDayKey, renderConversationDay } from "@omnesis/core";
import {
  fakeLocalFlow,
  loadActiveUniverse,
  loadSourceFixtureJson,
  preDiscoveredAccounts,
  universeAccounts,
  syncFromFixture,
  type SynthCursor,
} from "@omnesis/providers-synth-common";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
const conversationSchema = z
  .object({
    chatId: z.string(),
    chatName: z.string().optional(),
    platform: z.string().min(1),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            text: z.string().min(1),
            at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type ConversationFixture = z.infer<typeof conversationSchema>;
export function loadConversations(): ConversationFixture[] {
  const entries = z
    .array(conversationSchema)
    .parse(loadSourceFixtureJson<unknown>(loadActiveUniverse(), "hermes", "conversations.json"));
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = conversationExternalId(entry, entry.day);
    if (seen.has(key)) throw new Error(`Duplicate synthetic conversation aggregate: ${key}`);
    seen.add(key);
  }
  return entries;
}
export function mapConversation(
  entry: ConversationFixture,
  sourceId: SourceId,
  providerId: ProviderId,
): DocumentInput {
  const messages = entry.messages
    .map((message) => ({ role: message.role, text: message.text, atMs: Date.parse(message.at) }))
    .sort((a, b) => a.atMs - b.atMs);
  if (messages.some((message) => localDayKey(message.atMs) !== entry.day))
    throw new Error("Synthetic conversation messages must belong to their declared local day");
  return renderConversationDay({
    chat: { platform: entry.platform, chatId: entry.chatId, chatName: entry.chatName },
    dayKey: entry.day,
    messages,
    sourceId,
    providerId,
    agentName: "Hermes",
    harnessId: "hermes",
  });
}
const { type: _type, ...rest } = realSource;
/** Historical source transcripts use the production renderer, never an inference replay backend. */
export default defineSource<SynthCursor>({
  ...rest,
  gatewayHosted: false,
  execution: "pull",
  pushBased: false,
  discover: async () => preDiscoveredAccounts("hermes", universeAccounts("hermes")),
  authFlow: async () => fakeLocalFlow("hermes", universeAccounts("hermes")[0] ?? "synthetic"),
  async create({ sourceId, providerId }) {
    const entries = loadConversations();
    return {
      sync: async (cursor) =>
        syncFromFixture(entries, cursor, (entry) => mapConversation(entry, sourceId, providerId), {
          sourceId,
        }),
    };
  },
});
