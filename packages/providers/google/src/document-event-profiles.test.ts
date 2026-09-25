// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pins the Gmail and Google Calendar document-event profiles to what the
 * normalizers actually emit. Every assertion drives the real sync path over a
 * mocked API and compares the resulting documents against the declaration —
 * a document type or person role that only exists in the profile would let a
 * condition compile into a predicate that can never match.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import { validateDocumentEventProfile, type SyncCursor } from "@omnesis/source-sdk";
import { type DocumentInput, type PersonRole } from "@omnesis/types";
import {
  gmailDocumentEventProfile,
  googleCalendarDocumentEventProfile,
} from "./document-event-profiles.js";
import {
  createMockGmail,
  createGmailSource,
  createMockCalendar,
  createCalendarSource,
  makeCalendarEvent,
  makeCalendarListEntry,
} from "./testing/mock-google.js";
import { type GoogleCalendarSource } from "./calendar.js";
import googleProvider from "./index.js";

function rolesOf(doc: DocumentInput): PersonRole[] {
  return [...new Set((doc.metadata.people ?? []).map((p) => p.role))].sort();
}

function typesOf(docs: DocumentInput[]): string[] {
  return [...new Set(docs.map((d) => d.metadata.documentType ?? ""))].sort();
}

describe("document-event profiles are valid and wired into the descriptor", () => {
  test("both profiles satisfy the source-boundary contract", () => {
    expect(() => validateDocumentEventProfile(gmailDocumentEventProfile, "gmail")).not.toThrow();
    expect(() =>
      validateDocumentEventProfile(googleCalendarDocumentEventProfile, "google-calendar"),
    ).not.toThrow();
  });

  test("the Gmail and Google Calendar sources publish them", () => {
    const gmail = googleProvider.sources.find((s) => s.id === "gmail");
    const calendar = googleProvider.sources.find((s) => s.id === "google-calendar");
    expect(gmail?.documentEventProfile).toBe(gmailDocumentEventProfile);
    expect(calendar?.documentEventProfile).toBe(googleCalendarDocumentEventProfile);
  });
});

describe("Gmail profile matches the normalizer", () => {
  let gmail: ReturnType<typeof createMockGmail>;

  /**
   * A message from Maya Reeves to two colleagues whose body names a third
   * person, carrying one built-in label, one user-created label, and a PDF
   * attachment.
   */
  function makeMessage(overrides: { headers?: Array<{ name: string; value: string }> } = {}) {
    return {
      id: "msg-profile-1",
      threadId: "thread-profile-1",
      internalDate: "1704067200000",
      labelIds: ["INBOX", "STARRED", "Label_42"],
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "Subject", value: "Quarterly invoice" },
          { name: "From", value: "Maya Reeves <maya.reeves@example.com>" },
          { name: "To", value: "Jamie Lopez <jamie.lopez@example.com>" },
          { name: "Cc", value: "David Lin <david.lin@example.org>" },
          { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
          ...(overrides.headers ?? []),
        ],
        parts: [
          {
            mimeType: "text/plain",
            body: {
              data: Buffer.from(
                "Invoice attached. Billing questions go to sarah.mendez@example.com.",
              ).toString("base64url"),
            },
          },
          {
            filename: "invoice.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "att-1", size: 12345 },
          },
        ],
      },
    };
  }

  function sourceWithAttachments() {
    return createGmailSource(gmail, {
      attachmentConfig: {
        enabled: true,
        maxSizeBytes: 25_000_000,
        allowedTypes: ["application/pdf"],
        maxTextLength: 500_000,
      },
      extractAttachment: vi.fn(() =>
        Promise.resolve({ text: "Invoice total: 240.00", pages: 1, truncated: false }),
      ),
    });
  }

  beforeEach(() => {
    gmail = createMockGmail();
    gmail.users.labels.list = vi.fn(() =>
      Promise.resolve({
        data: {
          labels: [
            { id: "INBOX", name: "INBOX", type: "system" },
            { id: "STARRED", name: "STARRED", type: "system" },
            { id: "Label_42", name: "Receipts", type: "user" },
          ],
        },
      }),
    );
    gmail.users.messages.attachments.get = vi.fn(() =>
      Promise.resolve({ data: { data: Buffer.from("pdf-bytes").toString("base64url") } }),
    );
  });

  async function syncOne(message: Record<string, unknown>): Promise<DocumentInput[]> {
    gmail.users.messages.list = vi.fn(() =>
      Promise.resolve({ data: { messages: [{ id: message.id }] } }),
    );
    gmail.users.messages.get = vi.fn(() => Promise.resolve({ data: message }));
    const result = await sourceWithAttachments().sync(null);
    return result.documents;
  }

  test("emits exactly the declared document types", async () => {
    const docs = await syncOne(makeMessage());

    expect(typesOf(docs)).toEqual(["attachment", "email"]);
    expect(typesOf(docs).sort()).toEqual(
      [...(gmailDocumentEventProfile.documentTypes ?? [])].sort(),
    );
  });

  test("emits exactly the declared person roles", async () => {
    const docs = await syncOne(makeMessage());
    const declared = new Set(gmailDocumentEventProfile.personRoles);

    // The message names a sender, two recipients, and one address in the body.
    expect(rolesOf(docs[0])).toEqual(["mentioned", "recipient", "sender"]);
    // The attachment inherits the message's sender and recipients; its own
    // extracted text names nobody, so it carries no mentions.
    expect(rolesOf(docs[1])).toEqual(["recipient", "sender"]);
    for (const doc of docs) {
      for (const role of rolesOf(doc)) expect(declared).toContain(role);
    }
    expect([...declared].sort()).toEqual(["mentioned", "recipient", "sender"]);
  });

  test("metadata.tags carries resolved label names — uppercase for built-ins", async () => {
    const docs = await syncOne(makeMessage());
    const field = gmailDocumentEventProfile.metadataFields?.find((f) => f.path === "tags");
    const canonical = new Set(field?.canonicalValues);

    // The two built-in labels resolve to the identifiers the profile declares
    // as canonical; the user-created one resolves to its own name, which is why
    // the vocabulary is canonical rather than closed.
    expect(field?.type).toBe("string-array");
    expect(docs[0].metadata.tags).toEqual(["INBOX", "STARRED", "Receipts"]);
    expect(canonical).toContain("INBOX");
    expect(canonical).toContain("STARRED");
    expect(canonical).not.toContain("Receipts");
    // Neither of the labels that would hide a message is declared: SPAM and
    // TRASH messages are dropped rather than indexed.
    expect(canonical).not.toContain("SPAM");
    expect(canonical).not.toContain("TRASH");
    // Attachment documents carry no labels, as the field's description says.
    expect(docs[1].metadata.tags).toBeUndefined();
  });

  test("metadata.extra.threadId carries Gmail's conversation id", async () => {
    // Declared because a reply can only be recognised as a reply through it:
    // a condition about an unanswered thread has no other way to say which
    // messages belong together. The value is opaque and identical across every
    // message in the conversation.
    const docs = await syncOne(makeMessage());
    const field = gmailDocumentEventProfile.metadataFields?.find(
      (f) => f.path === "extra.threadId",
    );

    expect(field?.type).toBe("string");
    expect((docs[0].metadata.extra as Record<string, unknown> | undefined)?.threadId).toBe(
      "thread-profile-1",
    );
    // The attachment document is built from its own metadata rather than
    // inheriting the message's, so it carries no thread id — which is what the
    // field's description says, and a consumer keying a thread off it would
    // otherwise find the attachments quietly missing.
    expect(
      (docs[1].metadata.extra as Record<string, unknown> | undefined)?.threadId,
    ).toBeUndefined();
  });

  test("bulkMail and automatedSender are set only when the mail says so", async () => {
    const plain = await syncOne(makeMessage());
    expect(plain[0].metadata.bulkMail).toBeUndefined();
    expect(plain[0].metadata.automatedSender).toBeUndefined();

    const bulk = await syncOne(
      makeMessage({
        headers: [
          { name: "List-Unsubscribe", value: "<https://example.com/unsubscribe>" },
          { name: "Auto-Submitted", value: "auto-generated" },
        ],
      }),
    );
    expect(bulk[0].metadata.bulkMail).toBe(true);
    expect(bulk[0].metadata.automatedSender).toBe(true);

    const declared = new Set(gmailDocumentEventProfile.metadataFields?.map((f) => f.path));
    expect(declared).toContain("bulkMail");
    expect(declared).toContain("automatedSender");
  });
});

describe("Google Calendar profile matches the normalizer", () => {
  let calendar: ReturnType<typeof createMockCalendar>;

  async function drain(source: GoogleCalendarSource): Promise<DocumentInput[]> {
    let cursor: SyncCursor | null = null;
    const documents: DocumentInput[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await source.sync(cursor);
      documents.push(...res.documents);
      cursor = res.cursor;
      if (!res.hasMore) break;
    }
    return documents;
  }

  beforeEach(() => {
    calendar = createMockCalendar();
  });

  function seed(events: ReturnType<typeof makeCalendarEvent>[]) {
    calendar.calendarList.list = vi.fn(() =>
      Promise.resolve({ data: { items: [makeCalendarListEntry("cal-1", { summary: "Work" })] } }),
    );
    calendar.events.list = vi.fn(() =>
      Promise.resolve({ data: { items: events, nextSyncToken: "sync-tok-1" } }),
    );
    return createCalendarSource(calendar);
  }

  const event = makeCalendarEvent("evt-1", {
    summary: "Budget review",
    location: "Room 4",
    description: "Agenda and dial-in from sarah.mendez@example.com",
    organizer: { displayName: "Maya Reeves", email: "maya.reeves@example.com" },
    attendees: [{ displayName: "Jamie Lopez", email: "jamie.lopez@example.com" }],
  });

  test("emits exactly the declared document type and person roles", async () => {
    const docs = await drain(seed([event]));

    expect(docs).toHaveLength(1);
    expect(typesOf(docs)).toEqual(googleCalendarDocumentEventProfile.documentTypes);
    // Organizer → author, invitee → attendee, description address → mentioned.
    expect(rolesOf(docs[0])).toEqual(["attendee", "author", "mentioned"]);
    expect([...(googleCalendarDocumentEventProfile.personRoles ?? [])].sort()).toEqual(
      rolesOf(docs[0]),
    );
  });

  test("declares the metadata the normalizer writes under extra", async () => {
    const docs = await drain(seed([event]));
    const extra = docs[0].metadata.extra ?? {};

    expect(extra.status).toBe("confirmed");
    expect(extra.calendarName).toBe("Work");
    expect(extra.location).toBe("Room 4");
    for (const field of googleCalendarDocumentEventProfile.metadataFields ?? []) {
      expect(field.path.startsWith("extra.")).toBe(true);
      expect(extra[field.path.slice("extra.".length)]).toBeDefined();
    }
  });

  test("status stays inside the declared vocabulary, and cancelled events never reach a document", async () => {
    const allowed = googleCalendarDocumentEventProfile.metadataFields?.find(
      (f) => f.path === "extra.status",
    )?.allowedValues;
    expect(allowed).toEqual(["confirmed", "tentative"]);

    const docs = await drain(
      seed([
        event,
        makeCalendarEvent("evt-2", { summary: "Offsite", status: "tentative" }),
        makeCalendarEvent("evt-3", { summary: "Dropped", status: "cancelled" }),
      ]),
    );

    expect(docs.map((d) => d.title).sort()).toEqual(["Budget review", "Offsite"]);
    for (const doc of docs) {
      expect(allowed).toContain(doc.metadata.extra?.status);
    }
  });

  test("no tags field is declared — the normalizer always writes an empty array", async () => {
    const docs = await drain(seed([event]));

    expect(docs[0].metadata.tags).toEqual([]);
    expect(googleCalendarDocumentEventProfile.metadataFields?.some((f) => f.path === "tags")).toBe(
      false,
    );
  });
});
