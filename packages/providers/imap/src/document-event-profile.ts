// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the IMAP source's documents can be asked about — the document-side
 * declaration contract consumed by subscription compilation.
 *
 * Every entry describes the wire contract of `source.ts`'s normalizer: the
 * document type it emits, the person roles it really asserts, and the
 * metadata it really populates. A declaration the normalizer does not honour
 * would let a natural-language condition compile into a predicate that can
 * never match, so `document-event-profile.test.ts` pins these values to the
 * normalizer's actual output.
 */

import type { DocumentEventProfile } from "@omnesis/source-sdk";

export const imapDocumentEventProfile: DocumentEventProfile = {
  // One document per message, plus one child document per attachment whose
  // text was successfully extracted.
  documentTypes: ["email", "attachment"],
  // `From` becomes the sender; `To`, `Cc` and `Bcc` become recipients; email
  // addresses or phone numbers found in the body become mentions. An
  // attachment document inherits the sender and recipients of its message
  // and takes its mentions from its own extracted text.
  personRoles: ["sender", "recipient", "mentioned"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description:
        "The IMAP mailbox the message lives in — always exactly one entry, the server's mailbox path such as 'INBOX', 'Archive' or 'Receipts/2026'. Drafts, Junk and Trash are never synced, so no document carries those mailboxes. Attachment documents carry no mailbox tag.",
      canonicalValues: ["INBOX"],
      valueAliases: {
        INBOX: ["inbox", "in the inbox"],
      },
    },
    {
      path: "extra.threadId",
      type: "string",
      description:
        "Conversation identifier derived from the message's RFC threading headers — the root of References, else In-Reply-To, else the message's own Message-ID. Messages in a back-and-forth share it, which is what lets a reply be recognised as a reply. Opaque: never shown to a person and never parsed for meaning. Attachment documents carry no thread id, so a condition about a conversation matches the messages and not their attachments.",
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
