// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The list of chats Messages holds, as a filter offers them: each chat's
 * identifier, a name to show, and the phone numbers and email addresses of
 * its members.
 *
 * A day document carries its chat in `extra.chatIdentifier` and, as people,
 * the members known when the day was written. A filter on a person also reads
 * the members listed here, which is what covers a member of a group who is on
 * no day of it.
 *
 * One query over `chat`, `chat_handle_join` and `handle` produces the whole
 * list; no message row is read, so the cost follows the number of chats and
 * memberships.
 */

import { parseSourceKey } from "@omnesis/core";
import { imessagePersonIdentifiers } from "./imessage-normalizer.js";
import type { FilterIdentifier, FilterListItem, SourceId } from "@omnesis/types";
import type Database from "better-sqlite3";

/** Profile path of the chat a day document belongs to. */
export const IMESSAGE_CHAT_FIELD = "extra.chatIdentifier";

/** Members a group without a name is labelled by before the rest are counted. */
const LABEL_MEMBERS = 3;

interface ChatMemberRow {
  chatIdentifier: string;
  displayName: string | null;
  handle: string | null;
}

/**
 * Every chat in `chat.db` with its members.
 *
 * Messages can hold several rows for one chat identifier (the iMessage and
 * the SMS side of the same conversation); they are one chat here, as they are
 * one conversation in the day documents.
 *
 * An item is marked `membersIncomplete` when a member's handle is neither a
 * phone number nor an email address (a short code, a sender shown by name),
 * or when Messages records no member for the chat at all.
 */
export function listIMessageChats(db: Database.Database, sourceId: SourceId): FilterListItem[] {
  const rows = db
    .prepare(
      `SELECT c.chat_identifier AS chatIdentifier,
              c.display_name AS displayName,
              h.id AS handle
         FROM chat c
         LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
         LEFT JOIN handle h ON h.ROWID = chj.handle_id
        WHERE c.chat_identifier IS NOT NULL AND c.chat_identifier != ''
        ORDER BY c.chat_identifier ASC, h.id ASC`,
    )
    .all() as ChatMemberRow[];

  const chats = new Map<string, { displayName: string | null; handles: Set<string> }>();
  for (const row of rows) {
    let chat = chats.get(row.chatIdentifier);
    if (!chat) {
      chat = { displayName: null, handles: new Set() };
      chats.set(row.chatIdentifier, chat);
    }
    if (row.displayName && !chat.displayName) chat.displayName = row.displayName;
    if (row.handle) chat.handles.add(row.handle);
  }

  const self = imessagePersonIdentifiers(parseSourceKey(String(sourceId)).accountId);
  const items: FilterListItem[] = [];
  for (const [chatIdentifier, chat] of chats) {
    // Same rule as the day documents: more than one other member is a group.
    const isGroup = chat.handles.size > 1;
    const handles = new Set(chat.handles);
    // A one-to-one chat is identified by the other party's own handle.
    if (!isGroup && imessagePersonIdentifiers(chatIdentifier).length > 0) {
      handles.add(chatIdentifier);
    }

    const members = new Map<string, FilterIdentifier>();
    const add = (identifier: { kind: string; value: string }): void => {
      if (identifier.kind !== "phone" && identifier.kind !== "email") return;
      members.set(`${identifier.kind}\n${identifier.value}`, {
        type: identifier.kind,
        value: identifier.value,
      });
    };
    for (const identifier of self) add(identifier);
    let incomplete = handles.size === 0;
    for (const handle of handles) {
      const identifiers = imessagePersonIdentifiers(handle);
      if (identifiers.length === 0) incomplete = true;
      for (const identifier of identifiers) add(identifier);
    }

    items.push({
      id: chatIdentifier,
      label: chatLabel(chatIdentifier, chat.displayName, isGroup, [...chat.handles]),
      members: [...members.values()],
      ...(incomplete ? { membersIncomplete: true } : {}),
    });
  }
  return items;
}

/**
 * The group's name; for a group nobody named, its first members; for a
 * one-to-one chat, the other party's handle, as the day documents title it.
 */
function chatLabel(
  chatIdentifier: string,
  displayName: string | null,
  isGroup: boolean,
  handles: string[],
): string {
  if (!isGroup) return chatIdentifier;
  if (displayName) return displayName;
  const shown = handles.slice(0, LABEL_MEMBERS).join(", ");
  const rest = handles.length - LABEL_MEMBERS;
  return rest > 0 ? `${shown} +${rest}` : shown;
}
