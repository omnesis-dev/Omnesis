// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the gateway can say about filtering a source type, from the profile a
 * collector published. All fixture data is invented.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSourceDocumentProfilesTable,
  upsertSourceDocumentProfiles,
} from "../data/repositories/SourceDocumentProfileRepository.js";
import { filterFieldsFor } from "./filter-fields.js";
import type { DocumentEventProfile } from "@omnesis/source-sdk";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  createSourceDocumentProfilesTable(db);
});

afterEach(() => db.close());

const LABELS = {
  capability: "membership",
  minVersion: 2,
  scope: "global",
  noun: { one: "label", many: "labels" },
  picker: "search",
};

const FOLDERS = {
  capability: "tree",
  minVersion: 3,
  scope: "device",
  noun: { one: "folder", many: "folders" },
  levels: [
    { one: "device", many: "devices" },
    { one: "folder", many: "folders" },
  ],
  picker: "tree",
  inside: { one: "folder", many: "folders" },
};

const CHATS = {
  capability: "membership",
  minVersion: 0,
  scope: "global",
  noun: { one: "chat", many: "chats" },
  picker: "search",
  listsMembers: true,
};

/** Publish a profile as stored data, declarations unjudged, the way the route does. */
function publish(sourceType: string, outputRevision: number | undefined, profile: unknown): void {
  upsertSourceDocumentProfiles(
    db,
    [{ sourceType, outputRevision, profile: profile as DocumentEventProfile }],
    1000,
  );
}

function field(path: string, type: string, filter?: unknown): Record<string, unknown> {
  return { path, type, description: "An id.", ...(filter === undefined ? {} : { filter }) };
}

describe("filterFieldsFor", () => {
  it("says so when no collector has published a profile for the type", () => {
    publish("mailbox", 2, { documentTypes: ["email"] });
    expect(filterFieldsFor(db, "ledger")).toEqual({ state: "no-profile" });
  });

  it("says the collector is behind when the profile carries no source version", () => {
    // Even one that carries declarations: without a version there is nothing
    // to hold a `minVersion` against.
    publish("mailbox", undefined, {
      metadataFields: [field("extra.labelIds", "string-array", { ...LABELS, minVersion: 0 })],
    });
    expect(filterFieldsFor(db, "mailbox")).toEqual({ state: "collector-behind" });
  });

  it("reports a versioned profile that declares nothing filterable", () => {
    publish("mailbox", 2, {
      documentTypes: ["email"],
      metadataFields: [field("extra.threadId", "string")],
    });
    expect(filterFieldsFor(db, "mailbox")).toEqual({
      state: "declared",
      outputRevision: 2,
      fields: [],
      person: null,
    });
  });

  it("returns each filterable field with its declaration, in declaration order", () => {
    publish("files", 3, {
      metadataFields: [
        field("extra.folderId", "string", FOLDERS),
        field("extra.size", "number"),
        field("extra.labelIds", "string-array", LABELS),
        field("extra.chatId", "string", CHATS),
      ],
    });

    expect(filterFieldsFor(db, "files")).toEqual({
      state: "declared",
      outputRevision: 3,
      fields: [
        { path: "extra.folderId", state: "ready", type: "string", filter: FOLDERS },
        { path: "extra.labelIds", state: "ready", type: "string-array", filter: LABELS },
        { path: "extra.chatId", state: "ready", type: "string", filter: CHATS },
      ],
      person: null,
    });
  });

  it("returns the person filter", () => {
    const personFilter = {
      minVersion: 0,
      roles: ["sender", "recipient"],
      identifiers: ["email", "domain"],
      maxPeople: 1000,
    };
    publish("mailbox", 1, { personRoles: ["sender", "recipient", "mentioned"], personFilter });

    expect(filterFieldsFor(db, "mailbox")).toMatchObject({
      state: "declared",
      person: { state: "ready", filter: personFilter },
    });
  });

  it("accepts a person filter that draws members from a field's list", () => {
    const personFilter = {
      minVersion: 0,
      roles: ["participant"],
      identifiers: ["phone"],
      membersOf: "extra.chatId",
    };
    publish("chats", 1, {
      personRoles: ["participant"],
      metadataFields: [field("extra.chatId", "string", CHATS)],
      personFilter,
    });

    expect(filterFieldsFor(db, "chats")).toMatchObject({
      person: { state: "ready", filter: personFilter },
    });
  });

  describe("a capability this gateway does not have", () => {
    it("is reported as the gateway being behind, and never as applicable", () => {
      publish("files", 4, {
        metadataFields: [
          field("extra.modifiedOn", "string", {
            capability: "date-range",
            minVersion: 4,
            granularity: "day",
          }),
          field("extra.labelIds", "string-array", LABELS),
        ],
      });

      expect(filterFieldsFor(db, "files")).toEqual({
        state: "declared",
        outputRevision: 4,
        fields: [
          { path: "extra.modifiedOn", state: "gateway-behind", capability: "date-range" },
          { path: "extra.labelIds", state: "ready", type: "string-array", filter: LABELS },
        ],
        person: null,
      });
    });

    it("is reported whatever else the declaration holds", () => {
      // Nothing about an unknown capability's other keys can be checked, so
      // none of them is: a number field is fine for a capability that may
      // well match numbers.
      publish("ledger", 2, {
        metadataFields: [field("extra.amount", "number", { capability: "amount" })],
      });

      expect(filterFieldsFor(db, "ledger")).toMatchObject({
        fields: [{ path: "extra.amount", state: "gateway-behind", capability: "amount" }],
      });
    });
  });

  describe("a declaration that breaks the contract", () => {
    it.each([
      ["a minVersion above the published version", { ...LABELS, minVersion: 5 }, /minVersion 5/],
      ["a tree picker on a membership field", { ...LABELS, picker: "tree" }, /picker 'tree'/],
      ["a missing noun", { ...LABELS, noun: undefined }, /noun must be a noun/],
      ["no capability", { minVersion: 0 }, /unsupported capability 'undefined'/],
      ["the person capability", { ...LABELS, capability: "person" }, /'person' capability/],
      ["a value that is not an object", "membership", /must be an object/],
    ])("is reported as invalid for %s", (_label, filter, problem) => {
      publish("mailbox", 2, {
        metadataFields: [field("extra.labelIds", "string-array", filter)],
      });

      const result = filterFieldsFor(db, "mailbox");
      expect(result).toMatchObject({
        state: "declared",
        fields: [{ path: "extra.labelIds", state: "invalid" }],
      });
      if (result.state !== "declared" || result.fields[0]!.state !== "invalid") return;
      expect(result.fields[0]!.problem).toMatch(problem);
    });

    it("is reported as invalid on a field type a filter cannot read", () => {
      publish("mailbox", 2, { metadataFields: [field("extra.size", "number", LABELS)] });
      expect(filterFieldsFor(db, "mailbox")).toMatchObject({
        fields: [{ path: "extra.size", state: "invalid" }],
      });
    });

    it("does not take the source's other fields down with it", () => {
      publish("mailbox", 2, {
        metadataFields: [
          field("extra.labelIds", "string-array", { ...LABELS, scope: "account" }),
          field("extra.chatId", "string", CHATS),
        ],
      });

      expect(filterFieldsFor(db, "mailbox")).toMatchObject({
        fields: [
          { path: "extra.labelIds", state: "invalid" },
          { path: "extra.chatId", state: "ready" },
        ],
      });
    });

    it.each([
      ["an identifier this gateway does not know", { identifiers: ["handle"] }, /'handle'/],
      ["a role the profile does not populate", { roles: ["attendee"] }, /'attendee'/],
      ["a minVersion above the published version", { minVersion: 9 }, /minVersion 9/],
      ["members of a field with no member list", { membersOf: "extra.labelIds" }, /membersOf/],
    ])("reports an invalid person filter for %s", (_label, patch, problem) => {
      publish("mailbox", 2, {
        personRoles: ["sender"],
        metadataFields: [field("extra.labelIds", "string-array", LABELS)],
        personFilter: { minVersion: 0, roles: ["sender"], identifiers: ["email"], ...patch },
      });

      const result = filterFieldsFor(db, "mailbox");
      expect(result).toMatchObject({
        fields: [{ path: "extra.labelIds", state: "ready" }],
        person: { state: "invalid" },
      });
      if (result.state !== "declared" || result.person?.state !== "invalid") return;
      expect(result.person.problem).toMatch(problem);
    });
  });

  it("returns only the keys this build knows", () => {
    publish("mailbox", 2, {
      personRoles: ["sender"],
      metadataFields: [
        field("extra.labelIds", "string-array", { ...LABELS, aKeyFromALaterContract: 1 }),
      ],
      personFilter: {
        minVersion: 0,
        roles: ["sender"],
        identifiers: ["email"],
        aKeyFromALaterContract: 1,
      },
    });

    expect(filterFieldsFor(db, "mailbox")).toEqual({
      state: "declared",
      outputRevision: 2,
      fields: [{ path: "extra.labelIds", state: "ready", type: "string-array", filter: LABELS }],
      person: {
        state: "ready",
        filter: { minVersion: 0, roles: ["sender"], identifiers: ["email"] },
      },
    });
  });

  it("does not check a device scope against a multi-device mode it cannot see", () => {
    publish("files", 3, { metadataFields: [field("extra.folderId", "string", FOLDERS)] });
    expect(filterFieldsFor(db, "files")).toMatchObject({
      fields: [{ state: "ready", filter: { scope: "device" } }],
    });
  });

  it("reads a profile whose shape is not what any build publishes without throwing", () => {
    publish("odd", 2, {
      metadataFields: [7, null, { path: 3, filter: LABELS }, { filter: LABELS }, "extra.x"],
      personRoles: "sender",
      personFilter: null,
    });

    expect(filterFieldsFor(db, "odd")).toEqual({
      state: "declared",
      outputRevision: 2,
      fields: [],
      person: { state: "invalid", problem: "must be an object" },
    });

    publish("odder", 2, { metadataFields: "extra.labelIds" });
    expect(filterFieldsFor(db, "odder")).toMatchObject({ state: "declared", fields: [] });
  });

  it("says no profile when the stored row cannot be read at all", () => {
    publish("mailbox", 2, { documentTypes: ["email"] });
    db.prepare("UPDATE source_document_profiles SET profile_json = 'not json'").run();
    expect(filterFieldsFor(db, "mailbox")).toEqual({ state: "no-profile" });
  });
});
