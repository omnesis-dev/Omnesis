// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { whatsappPersonIdentifiers, buildContactsByLidJid } from "./normalizer.js";
import type { PersonMention, SourceId, SourceScopeConversationUpdate } from "@omnesis/types";
import type { StoredChat, StoredContact } from "./types.js";

/** Current roster excludes historical speakers who have since left the group. */
export function whatsappScopeMembership(input: {
  chatJid: string;
  chat: StoredChat | undefined;
  sourceId: SourceId;
  contacts: Map<string, StoredContact>;
  lidPhoneMap: Map<string, string>;
  senders: readonly string[];
  authoritativeRoster: boolean;
  uncertainRoster?: boolean;
  contested(jid: string): boolean;
  revision: { epoch: string; sequence: number };
  observedAt: string;
}): SourceScopeConversationUpdate {
  const byLid = buildContactsByLidJid(input.contacts);
  const group =
    input.chat?.isGroup || input.chatJid.endsWith("@g.us") || input.chatJid.endsWith("@broadcast");
  const snapshot = !group || input.authoritativeRoster;
  const jids =
    group && input.authoritativeRoster
      ? (input.chat?.participants ?? [])
      : [...input.senders, ...(input.chat?.participants ?? []), ...(!group ? [input.chatJid] : [])];
  const participants: PersonMention[] = [
    {
      role: "participant",
      isSelf: true,
      identifiers: whatsappPersonIdentifiers("", input.sourceId, input.lidPhoneMap, byLid, true),
    },
  ];
  for (const jid of [...new Set(jids.map((value) => value.replace(/:\d+(?=@)/, "")))].sort()) {
    const identifiers = whatsappPersonIdentifiers(
      jid,
      input.sourceId,
      input.lidPhoneMap,
      byLid,
    ).filter((identifier) => !input.contested(jid) || identifier.kind !== "phone");
    participants.push({ role: "participant", identifiers });
  }
  if (input.uncertainRoster) participants.push({ role: "participant", identifiers: [] });
  return {
    id: input.chatJid,
    // Oversized legacy rosters remain unknown instead of creating a page the
    // gateway can never accept. A later complete native roster can replace it.
    participants:
      participants.length > 4096
        ? [...participants.slice(0, 4095), { role: "participant", identifiers: [] }]
        : participants,
    mode: snapshot ? "snapshot" : "observed",
    observedAt: input.observedAt,
    revision: input.revision,
  };
}
