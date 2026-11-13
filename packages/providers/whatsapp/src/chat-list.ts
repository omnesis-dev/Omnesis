// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The list of chats a WhatsApp account has, as a filter offers them: each
 * chat's id, the name it is known by, and the phone numbers of its members.
 *
 * A day document carries its chat's id in `extra.chatJid` and, as people, the
 * members who were known when the day was written. Someone who has never
 * spoken in a group whose roster was not known then is on no day of it, so a
 * filter on a person also reads the members listed here.
 *
 * Everything comes from what the message store already holds in memory: the
 * chats WhatsApp announced, the rosters it delivered, the contacts and the
 * LID-to-phone map. No message is read, so the cost follows the number of
 * chats and memberships.
 */

import {
  buildContactsByLidJid,
  whatsappChatLabel,
  whatsappPersonIdentifiers,
  whatsappSelfIdentity,
} from "./normalizer.js";
import type { FilterListProducers } from "@omnesis/source-sdk";
import type { FilterIdentifier, FilterListItem, SourceId } from "@omnesis/types";
import type { StoredChat, StoredContact } from "./types.js";

/** Profile path of the chat a day document belongs to. */
export const WHATSAPP_CHAT_FIELD = "extra.chatJid";

/** What the list reads; the message store provides it. */
export interface WhatsAppChatDirectory {
  readonly allChats: ReadonlyMap<string, StoredChat>;
  readonly allContacts: Map<string, StoredContact>;
  readonly lidPhoneMap: Map<string, string>;
  isLidContested(lid: string): boolean;
}

/** A JID without the device suffix a roster or a sender may carry (`123:4@lid`). */
function bareJid(jid: string): string {
  return jid.replace(/:\d+(?=@)/, "");
}

/**
 * Every chat of the account with its members.
 *
 * An item is marked `membersIncomplete` when a filter cannot rely on its
 * members being all there:
 * - a member is known only by a WhatsApp LID that maps to no phone, or to
 *   more than one;
 * - the chat is a group whose whole roster WhatsApp has not delivered, so the
 *   roster holds at most the members seen joining;
 * - the chat is neither a group nor a one-to-one chat (a broadcast list, a
 *   channel), which has no roster at all.
 */
export function listWhatsAppChats(
  directory: WhatsAppChatDirectory,
  sourceId: SourceId,
): FilterListItem[] {
  const { allChats, allContacts, lidPhoneMap } = directory;
  const contactsByLidJid = buildContactsByLidJid(allContacts);
  const self = whatsappSelfIdentity(sourceId, lidPhoneMap);

  const phoneOf = (jid: string): string | undefined => {
    // A contested LID has been given two phones; neither is trusted, and the
    // contact fallback below would bring one of them back.
    if (jid.endsWith("@lid") && directory.isLidContested(jid)) return undefined;
    return whatsappPersonIdentifiers(jid, sourceId, lidPhoneMap, contactsByLidJid).find(
      (identifier) => identifier.kind === "phone",
    )?.value;
  };

  const items: FilterListItem[] = [];
  for (const chat of allChats.values()) {
    const jid = chat.jid;
    const oneToOne = jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
    const group = jid.endsWith("@g.us");
    const memberJids = oneToOne ? [jid] : group ? (chat.participants ?? []) : [];
    let incomplete = oneToOne ? false : group ? chat.rosterComplete !== true : true;

    const phones = new Set<string>();
    if (self.phone) phones.add(self.phone);
    for (const raw of new Set(memberJids.map(bareJid))) {
      if (self.isSelfJid(raw)) continue;
      const phone = phoneOf(raw);
      if (phone) phones.add(phone);
      else incomplete = true;
    }

    const members: FilterIdentifier[] = [...phones].map((value) => ({ type: "phone", value }));
    items.push({
      id: jid,
      label: whatsappChatLabel(chat, allContacts, lidPhoneMap, contactsByLidJid, self.isSelfJid),
      members,
      ...(incomplete ? { membersIncomplete: true } : {}),
    });
  }
  return items;
}

/** The list producers of a WhatsApp source, for `withFilterLists`. */
export function whatsappFilterLists(
  directory: WhatsAppChatDirectory,
  sourceId: SourceId,
): FilterListProducers {
  return { [WHATSAPP_CHAT_FIELD]: () => listWhatsAppChats(directory, sourceId) };
}
