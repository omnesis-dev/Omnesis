// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The labels of a Gmail account as a filter sees them.
 *
 * A message record carries the ids of its labels under
 * {@link GMAIL_LABELS_FIELD}. The names and the nesting live here: the list an
 * account publishes of the labels that exist in it. Gmail nests labels by
 * name alone, "Clients/Northstar" sitting inside "Clients", and a message
 * filed under the inner label does not carry the outer one. So the list is a
 * tree whose links are read from the names, and a rename in Gmail reshapes
 * the tree without touching any record.
 *
 * A record carries exactly the ids the list can contain: a filter treats a
 * record naming something the list lacks as one it cannot place.
 */

import type { FilterListItem } from "@omnesis/types";
import type { gmail_v1 } from "googleapis";

/** Profile path of the label ids a message carries. */
export const GMAIL_LABELS_FIELD = "extra.labelIds";

/**
 * Gmail's built-in labels a person would recognise from the Gmail sidebar and
 * inbox tabs, with the names Gmail shows for them. The API returns these
 * labels with `name` equal to `id`.
 *
 * Left out on purpose: `SPAM` and `TRASH`, whose messages are never indexed;
 * `UNREAD`, which says whether a message was opened rather than where it is
 * filed; and every other built-in id (star colours and the like), which Gmail
 * does not present as a label. Those ids are neither listed nor written on a
 * record.
 */
const GMAIL_SYSTEM_LABEL_NAMES: Readonly<Record<string, string>> = {
  INBOX: "Inbox",
  SENT: "Sent",
  DRAFT: "Drafts",
  STARRED: "Starred",
  IMPORTANT: "Important",
  CHAT: "Chats",
  CATEGORY_PERSONAL: "Primary",
  CATEGORY_SOCIAL: "Social",
  CATEGORY_PROMOTIONS: "Promotions",
  CATEGORY_UPDATES: "Updates",
  CATEGORY_FORUMS: "Forums",
};

/** Whether a label of the account is one a filter can name. */
function isListed(label: gmail_v1.Schema$Label): label is gmail_v1.Schema$Label & { id: string } {
  if (!label.id) return false;
  return label.id in GMAIL_SYSTEM_LABEL_NAMES || label.type === "user";
}

/** The ids of the account's labels a filter can name, from one `labels.list` response. */
export function gmailListedLabelIds(labels: readonly gmail_v1.Schema$Label[]): Set<string> {
  return new Set(labels.filter(isListed).map((label) => label.id));
}

/**
 * The label ids a message's record carries: those of the ids Gmail returned
 * that the account's list contains, once each. A message with none of them
 * has an empty list.
 */
export function gmailRecordLabelIds(
  labelIds: readonly string[] | null | undefined,
  listed: ReadonlySet<string>,
): string[] {
  return [...new Set((labelIds ?? []).filter((id) => listed.has(id)))];
}

/**
 * The tree of an account's labels, from one `labels.list` response: every
 * label the owner created, under its full name, and the recognisable built-in
 * ones under the name Gmail shows. A label sits inside the owner's label
 * whose full name is the text before its last "/", when the account has one;
 * otherwise, and for every built-in label, it is a root.
 */
export function gmailLabelItems(labels: readonly gmail_v1.Schema$Label[]): FilterListItem[] {
  const listed = labels.filter(isListed);
  const userIdByName = new Map<string, string>();
  for (const label of listed) {
    if (!(label.id in GMAIL_SYSTEM_LABEL_NAMES) && label.name)
      userIdByName.set(label.name, label.id);
  }
  return listed.map((label) => {
    const builtIn = GMAIL_SYSTEM_LABEL_NAMES[label.id];
    if (builtIn !== undefined) return { id: label.id, label: builtIn };
    const name = label.name || label.id;
    const slash = name.lastIndexOf("/");
    const parentId = slash > 0 ? userIdByName.get(name.slice(0, slash)) : undefined;
    return {
      id: label.id,
      label: name,
      ...(parentId !== undefined && parentId !== label.id ? { parentId } : {}),
    };
  });
}
