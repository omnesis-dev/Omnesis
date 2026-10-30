// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Deep links for a day document (`docs/telegram-source.md` §8.4).
 *
 * Telegram has a message link only for supergroups, forums and channels.
 * The link is always `t.me/c/<bare id>/<id>`: it names the chat by its id,
 * which never changes, and opens for a member, which the account archiving
 * it is. A `t.me/<username>/<id>` link would also open for a non-member, but
 * a username can be dropped and claimed by another chat, and a stored link
 * would then open someone else's chat.
 *
 * A private chat links at chat level through its username, the WhatsApp
 * precedent; there is no id-based link to a user, so the same reclaim risk
 * is accepted there (a username the person gave up and another account took
 * opens that account). A private chat without a username, a basic group and
 * Saved Messages get no link: the `tg://openmessage` scheme that could name
 * them is undocumented and has not been validated on a phone, so nothing is
 * emitted rather than a link that might open the wrong place. `appUrl` is
 * only a native scheme: a `t.me` message link is already a universal link,
 * so it is the `sourceUrl` alone.
 */

import type { StoredChat } from "./types.js";

/** Marked channel ids are `-100…`; links use the bare id. */
const CHANNEL_MARK = 1_000_000_000_000;

export function bareChannelId(markedId: number): number {
  return -markedId - CHANNEL_MARK;
}

export interface TelegramLinks {
  sourceUrl?: string;
  appUrl?: string;
}

/** Links for a day of `chat` whose first message is `firstMessageId`. */
export function telegramLinks(
  chat: Pick<StoredChat, "chatId" | "kind" | "username">,
  first: { msgId: number; topicId?: number },
): TelegramLinks {
  switch (chat.kind) {
    case "supergroup":
    case "forum":
    case "channel": {
      const thread = chat.kind === "forum" && first.topicId ? `${first.topicId}/` : "";
      const url = `https://t.me/c/${bareChannelId(chat.chatId)}/${thread}${first.msgId}`;
      // An https t.me link already opens the Telegram app where it is installed.
      return { sourceUrl: url };
    }
    case "private":
      return chat.username
        ? {
            sourceUrl: `https://t.me/${chat.username}`,
            appUrl: `tg://resolve?domain=${chat.username}`,
          }
        : {};
    case "saved":
    case "group":
      return {};
  }
}
