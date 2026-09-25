// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The source's `documentEventProfile` is read by the subscription compiler to
 * decide which document predicates it may build. A declared field or role the
 * normalizer never emits compiles a condition that can never fire, so these
 * tests pin every entry of the declaration to a document the source actually
 * produces rather than to the declaration itself.
 */

import { describe, test, expect } from "vitest";
import { buildAttachmentDocument } from "@omnesis/core";
import { validateDocumentEventProfile } from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import { normalizeDayChat } from "./normalizer.js";
import whatsappSource from "./index.js";
import type { DocumentMetadataFieldSpec } from "@omnesis/source-sdk";
import type { DocumentInput, PersonRole } from "@omnesis/types";
import type { StoredChat, StoredContact, StoredMessage } from "./types.js";

const profile = whatsappSource.documentEventProfile!;

const PROVIDER = ProviderId("whatsapp:+15550100001");
const SOURCE = SourceId("whatsapp-messages:+15550100001");

function makeMsg(overrides: Partial<StoredMessage>): StoredMessage {
  return {
    id: "m1",
    chatJid: "120000000000000001@g.us",
    senderJid: "15550100123@s.whatsapp.net",
    senderName: "Maya Reeves",
    fromMe: false,
    timestamp: 1_709_900_000,
    type: "text",
    text: "Hello",
    ...overrides,
  };
}

const contacts = new Map<string, StoredContact>([
  ["15550100123@s.whatsapp.net", { jid: "15550100123@s.whatsapp.net", name: "Maya Reeves" }],
  ["15550100200@s.whatsapp.net", { jid: "15550100200@s.whatsapp.net", name: "Jamie Lopez" }],
]);

/** A group day-chat carrying text, media and a body-mentioned outsider. */
function groupDoc(): DocumentInput {
  const chat: StoredChat = {
    jid: "120000000000000001@g.us",
    name: "Studio Northstar crew",
    isGroup: true,
    participants: [
      "15550100001@s.whatsapp.net", // self
      "15550100123@s.whatsapp.net",
      "15550100200@s.whatsapp.net",
    ],
  };
  const messages = [
    makeMsg({ id: "m1", text: "ping David Lin on +15550100099 about the booking" }),
    makeMsg({
      id: "m2",
      senderJid: "15550100200@s.whatsapp.net",
      senderName: "Jamie Lopez",
      timestamp: 1_709_900_060,
      type: "image",
      text: "the floor plan",
      media: { mimetype: "image/jpeg", filename: "floor-plan.jpg" },
    }),
    makeMsg({
      id: "m3",
      fromMe: true,
      senderJid: "15550100001@s.whatsapp.net",
      timestamp: 1_709_900_120,
      text: "on it",
    }),
  ];
  return normalizeDayChat(
    "120000000000000001@g.us",
    "2026-03-08",
    messages,
    chat,
    contacts,
    PROVIDER,
    SOURCE,
  );
}

/** A one-to-one day-chat — the shape that leaves `tags` empty. */
function oneToOneDoc(): DocumentInput {
  const chat: StoredChat = {
    jid: "15550100123@s.whatsapp.net",
    name: "Maya Reeves",
    isGroup: false,
  };
  const messages = [
    makeMsg({
      id: "m1",
      chatJid: "15550100123@s.whatsapp.net",
      text: "sending the invoice to sarah.mendez@example.com",
    }),
  ];
  return normalizeDayChat(
    "15550100123@s.whatsapp.net",
    "2026-03-08",
    messages,
    chat,
    contacts,
    PROVIDER,
    SOURCE,
  );
}

/** The child document `extractMediaAttachments` builds per extracted file. */
function attachmentDoc(): DocumentInput {
  return buildAttachmentDocument(
    groupDoc(),
    "floor-plan.pdf",
    { text: "Riverside Estate — ground floor", truncated: false },
    { mimeType: "application/pdf", sizeBytes: 24_000, seq: 0 },
  );
}

/** Resolve a declared dotted path against a document's `metadata`. */
function readPath(doc: DocumentInput, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined,
      doc.metadata,
    );
}

function matchesDeclaredType(value: unknown, type: DocumentMetadataFieldSpec["type"]): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "string-array":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
  }
}

describe("whatsapp documentEventProfile", () => {
  test("satisfies the source-boundary contract", () => {
    expect(() => validateDocumentEventProfile(profile, "provider-whatsapp")).not.toThrow();
  });

  test("declares exactly the document types the source emits", () => {
    const emitted = new Set(
      [groupDoc(), oneToOneDoc(), attachmentDoc()].map((doc) => String(doc.metadata.documentType)),
    );
    expect(new Set(profile.documentTypes)).toEqual(emitted);
  });

  test("declares exactly the person roles the source populates", () => {
    const emitted = new Set<PersonRole>();
    for (const doc of [groupDoc(), oneToOneDoc(), attachmentDoc()]) {
      for (const person of doc.metadata.people ?? []) emitted.add(person.role);
    }
    expect(emitted).toContain("participant");
    expect(emitted).toContain("mentioned");
    expect(new Set(profile.personRoles)).toEqual(emitted);
  });

  test("every declared metadata field is present, and correctly typed, on a group day-chat", () => {
    const doc = groupDoc();
    for (const field of profile.metadataFields ?? []) {
      const value = readPath(doc, field.path);
      expect(value, `${field.path} is missing`).toBeDefined();
      expect(matchesDeclaredType(value, field.type), `${field.path} is not a ${field.type}`).toBe(
        true,
      );
    }
  });

  test("the tags vocabulary is exhaustive across group and one-to-one chats", () => {
    const allowed = new Set(
      profile.metadataFields?.find((f) => f.path === "tags")?.allowedValues ?? [],
    );
    expect(allowed).toEqual(new Set(["group"]));
    expect(groupDoc().metadata.tags).toEqual(["group"]);
    expect(oneToOneDoc().metadata.tags).toEqual([]);
  });

  test("the declared group/one-to-one fields track the chat kind", () => {
    const group = groupDoc();
    expect(readPath(group, "extra.isGroup")).toBe(true);
    expect(readPath(group, "extra.chatName")).toBe("Studio Northstar crew");
    expect(readPath(group, "extra.chatJid")).toBe("120000000000000001@g.us");
    expect(readPath(group, "extra.participants")).toEqual(
      expect.arrayContaining(["Maya Reeves", "Jamie Lopez", "You"]),
    );

    const oneToOne = oneToOneDoc();
    expect(readPath(oneToOne, "extra.isGroup")).toBe(false);
    expect(readPath(oneToOne, "extra.chatName")).toBe("Maya Reeves");
  });

  test("the declared counts exclude reactions and count media messages", () => {
    const doc = groupDoc();
    expect(readPath(doc, "extra.messageCount")).toBe(3);
    expect(readPath(doc, "extra.mediaCount")).toBe(1);
  });
});
