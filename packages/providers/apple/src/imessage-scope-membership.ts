// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseSourceKey } from "@omnesis/core";
import { imessagePersonIdentifiers } from "./imessage-normalizer.js";
import type { SourceId, PersonMention, SourceScopeConversationUpdate } from "@omnesis/types";
import type { IMessageChatInfo, ParsedIMessage } from "./imessage-types.js";

/** Current chat_handle_join membership is independent of an old day's speakers. */
export function imessageScopeMembership(
  chat: IMessageChatInfo,
  sourceId: SourceId,
  messages: readonly ParsedIMessage[],
  observation: { epoch: string; sequence: number; observedAt: string; refreshEpoch?: string },
): SourceScopeConversationUpdate {
  const self = imessagePersonIdentifiers(parseSourceKey(sourceId).accountId);
  const participants: PersonMention[] = [{ role: "participant", isSelf: true, identifiers: self }];
  const handles =
    chat.participantHandles !== undefined
      ? [...chat.participantHandles]
      : messages
          .filter((message) => !message.isFromMe)
          .map((message) => message.contactId || message.sender);
  if (!chat.isGroup && imessagePersonIdentifiers(chat.chatIdentifier).length)
    handles.push(chat.chatIdentifier);
  if (handles.length === 0) participants.push({ role: "participant", identifiers: [] });
  for (const handle of [...new Set(handles)].sort())
    participants.push({ role: "participant", identifiers: imessagePersonIdentifiers(handle) });
  return {
    ...(observation.refreshEpoch ? { refreshEpoch: observation.refreshEpoch } : {}),
    id: chat.chatIdentifier,
    // Oversized legacy rosters remain unknown instead of creating a page the
    // gateway can never accept. A later complete native roster can replace it.
    participants:
      participants.length > 4096
        ? [...participants.slice(0, 4095), { role: "participant", identifiers: [] }]
        : participants,
    mode: chat.participantHandles !== undefined ? "snapshot" : "observed",
    observedAt: observation.observedAt,
    revision: { epoch: observation.epoch, sequence: observation.sequence },
  };
}
