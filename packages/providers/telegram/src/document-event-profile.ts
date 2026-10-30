// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a condition can address on Telegram day documents
 * (`docs/telegram-source.md` §8.5). One `conversation` document covers one
 * chat on one UTC day. Everyone who spoke that day, plus the other side of a
 * private chat, with the account holder as "You", is a `participant`; email
 * addresses and phone numbers in the day's text that belong to nobody in it
 * are `mentioned`.
 *
 * An `attachment` document is a photo's OCR text or a document's extracted
 * text, a child of the day it was sent on. The chat fields below describe
 * the conversation; an attachment carries the shared attachment metadata.
 */

import type { DocumentEventProfile } from "@omnesis/source-sdk";

export const CHAT_KINDS = ["private", "saved", "group", "supergroup", "forum", "channel"] as const;

export const telegramDocumentEventProfile: DocumentEventProfile = {
  documentTypes: ["conversation", "attachment"],
  personRoles: ["participant", "mentioned"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description:
        "Carries 'group' on a group, supergroup or forum conversation and is empty otherwise.",
      allowedValues: ["group"],
      valueAliases: { group: ["group chat", "group conversation", "groups"] },
    },
    {
      path: "extra.isGroup",
      type: "boolean",
      description: "True for a group, supergroup or forum conversation.",
      semantics: "group-conversation",
    },
    {
      path: "extra.chatName",
      type: "string",
      // A private chat's name is the other person.
      identifiesPeople: true,
      description:
        "The chat's name in Telegram: the group or channel title, or the other person's name for a private chat.",
    },
    {
      path: "extra.chatId",
      type: "string",
      // A private chat's id is the other user's id.
      identifiesPeople: true,
      description:
        "Telegram's identifier for the chat. Every day of the same conversation repeats it.",
    },
    {
      path: "extra.chatKind",
      type: "string",
      description:
        "What kind of Telegram chat this is: a private chat, Saved Messages, a basic group, a supergroup, a forum, or a broadcast channel.",
      allowedValues: [...CHAT_KINDS],
    },
    {
      path: "extra.isArchived",
      type: "boolean",
      description: "True when the chat sits in the Telegram archive folder.",
    },
    {
      path: "extra.participants",
      type: "string-array",
      identifiesPeople: true,
      description:
        "Display name of everyone in the conversation that day, including the other side of a private chat; the account holder always appears as 'You'.",
    },
    {
      path: "extra.messageCount",
      type: "number",
      description: "Messages exchanged that day, excluding service notices.",
      semantics: "message-count",
    },
    {
      path: "extra.topics",
      type: "string-array",
      description:
        "On a forum conversation, the titles of the topics that day's messages were posted in. Absent when no message names a topic.",
    },
    {
      path: "extra.mediaCount",
      type: "number",
      description:
        "Messages that day carrying a photo, file, audio, video, sticker or other media.",
    },
  ],
};
