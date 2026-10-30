// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The declared `documentEventProfile` against documents a real sync emits:
 * a declared field or role the normalizer never produces compiles a
 * condition that can never fire, so every entry is pinned to output.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveAttachmentConfig } from "@omnesis/core";
import { validateDocumentEventProfile } from "@omnesis/source-sdk";
import { CHAT_KINDS } from "./document-event-profile.js";
import {
  DAVID,
  JAMIE,
  T0,
  chatOf,
  latestDocs,
  messageIn,
  privateChatWith,
  syncAll,
  syncRig,
  type SyncRig,
} from "./testing/fixtures.js";
import telegram from "./index.js";
import type { DocumentMetadataFieldSpec } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";

const profile = telegram.sources[0]!.documentEventProfile!;
const GROUP = chatOf(-1006000000006, "supergroup", "Studio Northstar crew");
const JAMIE_CHAT = privateChatWith(JAMIE);
const FORUM = chatOf(-1006000000007, "forum", "Riverside Estate planning");
/** Fields only some chat shapes carry. */
const FORUM_ONLY = new Set(["extra.topics"]);

function readPath(doc: DocumentInput, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined,
      doc.metadata,
    );
}

function matchesType(value: unknown, type: DocumentMetadataFieldSpec["type"]): boolean {
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

describe("telegram documentEventProfile", () => {
  let rig: SyncRig;
  let docs: Map<string, DocumentInput>;

  beforeAll(async () => {
    rig = await syncRig(
      {
        users: [JAMIE, DAVID],
        chats: [
          {
            chat: GROUP,
            messages: [
              messageIn(GROUP, 1, T0, "Ping David Lin on +1 202-555-0188 about the booking", {
                senderId: JAMIE.id,
              }),
              messageIn(GROUP, 2, T0 + 60, "floor plan", {
                senderId: DAVID.id,
                media: {
                  kind: "photo",
                  fileId: "f1",
                  mimeType: "image/jpeg",
                  size: 2048,
                  isViewOnce: false,
                },
              }),
            ],
          },
          {
            chat: JAMIE_CHAT,
            messages: [
              messageIn(JAMIE_CHAT, 3, T0, "Invoice goes to billing@example.com", {
                senderId: JAMIE.id,
              }),
            ],
          },
          {
            chat: FORUM,
            topics: [{ id: 10, title: "Catering" }],
            messages: [
              messageIn(FORUM, 11, T0, "Menu tasting moved to Thursday", {
                senderId: DAVID.id,
                topicId: 10,
              }),
            ],
          },
        ],
      },
      {
        attachmentConfig: resolveAttachmentConfig(undefined, { defaultEnabled: true }),
        // The host's OCR, stubbed: no model runs.
        extractAttachment: () =>
          Promise.resolve({ text: "Room 4 is the studio, call +1 202-555-0177", truncated: false }),
      },
    );
    rig.sim.setMedia("f1", new TextEncoder().encode("floor plan scan"));
    docs = latestDocs((await syncAll(rig.source, null)).pages);
  });

  afterAll(async () => {
    await rig.dispose();
  });

  const group = (): DocumentInput => docs.get(`${GROUP.id}:2026-03-10`)!;
  const oneToOne = (): DocumentInput => docs.get(`${JAMIE.id}:2026-03-10`)!;
  const forum = (): DocumentInput => docs.get(`${FORUM.id}:2026-03-10`)!;
  const attachment = (): DocumentInput =>
    [...docs.values()].find((d) => d.metadata.documentType === "attachment")!;

  it("satisfies the source-boundary contract", () => {
    expect(() => validateDocumentEventProfile(profile, "provider-telegram")).not.toThrow();
  });

  it("declares exactly the document types and person roles the source emits", () => {
    const all = [...docs.values()];
    expect(new Set(profile.documentTypes)).toEqual(
      new Set(all.map((d) => String(d.metadata.documentType))),
    );
    const roles = new Set(all.flatMap((d) => (d.metadata.people ?? []).map((p) => p.role)));
    expect(new Set(profile.personRoles)).toEqual(roles);
  });

  it("every declared field is present and typed on every chat shape that carries it", () => {
    for (const doc of [group(), oneToOne(), forum()]) {
      for (const field of profile.metadataFields ?? []) {
        const value = readPath(doc, field.path);
        if (FORUM_ONLY.has(field.path) && doc !== forum()) {
          expect(
            value,
            `${field.path} on a ${String(doc.metadata.extra?.chatKind)}`,
          ).toBeUndefined();
          continue;
        }
        expect(value, `${field.path} is missing`).toBeDefined();
        expect(matchesType(value, field.type), `${field.path} is not a ${field.type}`).toBe(true);
        if (field.allowedValues && typeof value === "string") {
          expect(field.allowedValues).toContain(value);
        }
      }
    }
  });

  it("tracks the chat kind in tags, isGroup and chatKind", () => {
    expect(group().metadata.tags).toEqual(["group"]);
    expect(oneToOne().metadata.tags).toEqual([]);
    expect(readPath(group(), "extra.isGroup")).toBe(true);
    expect(readPath(oneToOne(), "extra.isGroup")).toBe(false);
    expect(readPath(group(), "extra.chatKind")).toBe("supergroup");
    expect(readPath(oneToOne(), "extra.chatName")).toBe("Jamie Lopez");
    expect(profile.metadataFields?.find((f) => f.path === "extra.chatKind")?.allowedValues).toEqual(
      [...CHAT_KINDS],
    );
  });

  it("emits the photo's text as an attachment of the day, with its people", () => {
    expect(attachment().metadata.extra?.parentExternalId).toBe(group().externalId);
    // Mentions are scoped to the file; participants come from the day.
    const roles = new Set((attachment().metadata.people ?? []).map((p) => p.role));
    expect([...roles].every((r) => profile.personRoles?.includes(r))).toBe(true);
  });

  it("names a forum day's topics", () => {
    expect(readPath(forum(), "extra.topics")).toEqual(["Catering"]);
    expect(forum().content).toContain("[#Catering] David Lin: Menu tasting moved to Thursday");
  });

  it("counts messages and media", () => {
    expect(readPath(group(), "extra.messageCount")).toBe(2);
    expect(readPath(group(), "extra.mediaCount")).toBe(1);
  });
});
