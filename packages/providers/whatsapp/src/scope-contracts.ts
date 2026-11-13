// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceScopes } from "@omnesis/types";

/** Pure source-owned metadata, also packaged for gateways with older collectors. */
export const scopeContracts = {
  "whatsapp-messages": {
    revision: 2,
    items: [
      {
        kind: "conversation",
        noun: { one: "conversation", many: "conversations" },
        picker: "search",
        link: "fixed",
      },
      { kind: "participant", identifiers: ["phone"], link: "changes" },
    ],
    legacyProjection: {
      conversationIdPath: ["extra", "conversationId"],
      conversationLabelPath: ["extra", "chatName"],
      participants: {
        roles: ["participant"],
        membership: "conversation",
        snapshotPath: ["extra", "scopeConversation"],
      },
    },
  },
} satisfies Record<string, SourceScopes>;
