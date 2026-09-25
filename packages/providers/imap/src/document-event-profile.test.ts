// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pins the IMAP document-event profile to what the normalizer actually emits.
 * Every assertion drives the real sync path over a fake client and compares
 * the resulting documents against the declaration — a document type or person
 * role that only exists in the profile would let a condition compile into a
 * predicate that can never match.
 */

import { describe, expect, it } from "vitest";
import { resolveAttachmentConfig } from "@omnesis/core";
import { validateDocumentEventProfile } from "@omnesis/source-sdk";
import { imapDocumentEventProfile } from "./document-event-profile.js";
import { ImapEmailSource } from "./source.js";
import imapProvider from "./index.js";
import type { DocumentInput, PersonRole } from "@omnesis/types";
import type { ImapClient, ImapMailbox, ImapMailboxState, ImapMessage } from "./source.js";

class ProfileFakeClient implements ImapClient {
  constructor(
    private readonly state: ImapMailboxState,
    private readonly messages: ImapMessage[],
  ) {}

  connect(): Promise<void> {
    return Promise.resolve();
  }

  list(): Promise<ImapMailbox[]> {
    return Promise.resolve([{ path: "INBOX", flags: new Set<string>() }]);
  }

  open(): Promise<ImapMailboxState> {
    return Promise.resolve(this.state);
  }

  search(): Promise<number[]> {
    return Promise.resolve(this.messages.map((row) => row.uid));
  }

  fetch(uids: number[]): Promise<ImapMessage[]> {
    return Promise.resolve(this.messages.filter((row) => uids.includes(row.uid)));
  }

  fetchMetadata(uids: number[]): Promise<Array<{ uid: number; date?: Date }>> {
    return Promise.resolve(uids.map((uid) => ({ uid, date: new Date() })));
  }

  fetchAttachment(): Promise<Uint8Array> {
    return Promise.resolve(new TextEncoder().encode("Invoice total: 240.00"));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A message from a newsletter machine to one recipient whose body names a
 * third person — exercises every declared marker at once.
 */
const newsletter: ImapMessage = {
  uid: 7,
  envelope: {
    subject: "August product notes",
    date: new Date("2026-08-05T08:00:00.000Z"),
    from: [{ name: "Stellar Sound", address: "noreply@example.com" }],
    to: [{ name: "Maya Reeves", address: "maya.reeves@example.org" }],
    messageId: "<notes-7@example.com>",
    inReplyTo: "<notes-6@example.com>",
  },
  internalDate: new Date("2026-08-05T08:00:00.000Z"),
  references: ["<notes-1@example.com>"],
  listUnsubscribe: "<https://example.com/unsubscribe>",
  attachments: [
    { part: "2", filename: "product-notes.pdf", mimeType: "application/pdf", size: 2048 },
  ],
  text: "New in August. Questions go to jamie.lopez@example.org.",
};

async function syncDocs(): Promise<DocumentInput[]> {
  const client = new ProfileFakeClient({ uidValidity: "61", uidNext: 8 }, [newsletter]);
  const source = new ImapEmailSource(
    "imap:a@example.com",
    "imap:a@example.com",
    () => client,
    undefined,
    {
      attachmentConfig: resolveAttachmentConfig(undefined, { defaultEnabled: true }),
      extractAttachment: () =>
        Promise.resolve({ text: "Invoice total: 240.00", pages: 1, truncated: false }),
    },
  );
  return (await source.sync(null)).documents;
}

function rolesOf(doc: DocumentInput): PersonRole[] {
  return [...new Set((doc.metadata.people ?? []).map((p) => p.role))].sort();
}

describe("IMAP document-event profile", () => {
  it("satisfies the source-boundary contract and is wired into the descriptor", () => {
    expect(() => validateDocumentEventProfile(imapDocumentEventProfile, "imap")).not.toThrow();
    const entry = imapProvider.sources.find((s) => s.id === "imap");
    expect(entry?.documentEventProfile).toBe(imapDocumentEventProfile);
  });

  it("declares the scheduled/due temporal projections the normalizer feeds", () => {
    // Pinned exactly: losing a slot (or its deadline kind) would silently
    // stop materializing tp_ rows for the scheduledAt/dueAt promotion the
    // normalizer emits, while every structural validation still passes.
    const entry = imapProvider.sources.find((s) => s.id === "imap");
    expect(entry?.documentTemporalProjections).toEqual([
      {
        slot: "scheduled",
        start: "scheduledAt",
        kind: "event",
        modality: "asserted",
        status: "active",
      },
      {
        slot: "due",
        start: "dueAt",
        kind: "deadline",
        modality: "asserted",
        status: "active",
      },
    ]);
  });

  it("emits exactly the declared document types and person roles", async () => {
    const docs = await syncDocs();

    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.metadata.documentType).sort()).toEqual(["attachment", "email"]);
    expect([...(imapDocumentEventProfile.documentTypes ?? [])].sort()).toEqual([
      "attachment",
      "email",
    ]);
    expect(rolesOf(docs[0])).toEqual(["mentioned", "recipient", "sender"]);
    expect([...(imapDocumentEventProfile.personRoles ?? [])].sort()).toEqual(rolesOf(docs[0]));
    // The attachment inherits the message's sender and recipient; its own
    // extracted text names nobody, so it carries no mentions.
    expect(rolesOf(docs[1])).toEqual(["recipient", "sender"]);
    for (const role of rolesOf(docs[1])) {
      expect(imapDocumentEventProfile.personRoles).toContain(role);
    }
  });

  it("populates every declared metadata field", async () => {
    const docs = await syncDocs();
    const metadata = docs[0].metadata;
    const extra = (metadata.extra ?? {}) as Record<string, unknown>;
    const declared = new Set(imapDocumentEventProfile.metadataFields?.map((f) => f.path));

    expect(declared).toEqual(new Set(["tags", "extra.threadId", "bulkMail", "automatedSender"]));
    // Exactly one tag: the mailbox path.
    expect(metadata.tags).toEqual(["INBOX"]);
    // Thread id is the root of References.
    expect(extra.threadId).toBe("<notes-1@example.com>");
    // List-Unsubscribe → bulkMail; the no-reply local part → automatedSender.
    expect(metadata.bulkMail).toBe(true);
    expect(metadata.automatedSender).toBe(true);
  });
});
