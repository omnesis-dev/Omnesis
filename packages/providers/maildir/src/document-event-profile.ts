// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the Maildir source's documents can be asked about — the document-side
 * declaration contract consumed by subscription compilation.
 *
 * Every entry describes what `normalizer.ts` writes; the parity test pins
 * these values to the normalizer's actual output through the real sync path.
 */

import type { DocumentEventProfile } from "@omnesis/source-sdk";

export const maildirDocumentEventProfile: DocumentEventProfile = {
  // One document per message, however many folders hold a copy of it, plus
  // one child document per attachment whose text was extracted.
  documentTypes: ["email", "attachment"],
  // `From` becomes the sender; `To`, `Cc` and `Bcc` become recipients; email
  // addresses or phone numbers found in the body become mentions. An
  // attachment document inherits the sender and recipients of its message.
  personRoles: ["sender", "recipient", "mentioned"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description:
        "Where the message is filed, one tag per folder holding a copy. The inbox and Gmail's own folders use the same words as Gmail's labels — INBOX, SENT (any sent-mail folder), STARRED (Gmail's Starred folder, or a copy flagged in any folder) and IMPORTANT — so they match mail from the Gmail source; Gmail's All Mail gives no tag. Any other folder appears by the name the mail tool gave it, such as 'Receipts' or 'Work/Travel'. Drafts, spam and trash folders are never synced. Gmail's inbox categories and unread state are not visible in a Maildir. Attachment documents carry no tags.",
      canonicalValues: ["INBOX", "SENT", "STARRED", "IMPORTANT"],
      valueAliases: {
        INBOX: ["inbox", "in the inbox"],
        SENT: ["sent", "sent mail", "mail I sent"],
        STARRED: ["starred", "flagged"],
        IMPORTANT: ["important", "marked important"],
      },
    },
    {
      path: "extra.threadId",
      type: "string",
      description:
        "Conversation identifier derived from the message's RFC threading headers — the root of References, else In-Reply-To, else the message's own Message-ID. Messages in a back-and-forth share it. Opaque: never shown to a person and never parsed for meaning. Attachment documents carry no thread id.",
    },
    {
      path: "extra.flagged",
      type: "boolean",
      description:
        "True when a copy of the message is flagged — starred in Gmail, flagged in other mail apps. Absent, never false, on the rest.",
    },
    {
      path: "extra.answered",
      type: "boolean",
      description:
        "True when a copy of the message is marked as replied to. Absent, never false, on the rest.",
    },
    {
      path: "bulkMail",
      type: "boolean",
      description:
        "True when the message carried a List-Unsubscribe header — newsletters, marketing, mailing lists and anything else mass-distributed. Absent, never false, on the rest.",
    },
    {
      path: "automatedSender",
      type: "boolean",
      description:
        "True when the message came from a machine that expects no reply — a no-reply or notifications sender address, or an Auto-Submitted header. Distinct from bulk mail: this is transactional notification traffic. Absent, never false, on the rest.",
    },
  ],
};
