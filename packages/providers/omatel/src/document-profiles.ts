// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DocumentEventProfile } from "@omnesis/source-sdk";

const SMS_ALIASES: Record<string, string[]> = { SMS: ["sms", "mms", "text message"] };

/** One document per conversation and UTC day. */
export const omatelMessagesDocumentProfile: DocumentEventProfile = {
  documentTypes: ["conversation"],
  personRoles: ["participant"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description: "Messaging service the day's conversation was carried over.",
      canonicalValues: ["SMS"],
      valueAliases: SMS_ALIASES,
    },
    {
      path: "extra.service",
      type: "string",
      description: "Messaging service carrying the conversation — the same value the tag carries.",
      canonicalValues: ["SMS"],
      valueAliases: SMS_ALIASES,
    },
    {
      path: "extra.isGroup",
      type: "boolean",
      description: "Whether the conversation has more than one other member.",
      semantics: "group-conversation",
    },
    {
      path: "extra.messageCount",
      type: "number",
      description: "Number of messages exchanged in the conversation that day.",
      semantics: "message-count",
    },
    {
      path: "extra.chatName",
      type: "string",
      // A one-to-one conversation's title is the other party's name.
      identifiesPeople: true,
      description: "The conversation's title in the Messages app. Absent when it has none.",
    },
  ],
};

/** One document per UTC day, aggregating every call that day. */
export const omatelCallsDocumentProfile: DocumentEventProfile = {
  documentTypes: ["call-log"],
  personRoles: ["participant"],
  metadataFields: [
    {
      path: "extra.callCount",
      type: "number",
      description: "Calls placed or received on the day this document covers.",
    },
    {
      path: "extra.totalDurationSeconds",
      type: "number",
      description: "Seconds spent on answered calls that day; other calls contribute nothing.",
    },
  ],
};
