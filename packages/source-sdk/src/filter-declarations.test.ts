// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Filter declarations on a document-event profile: `filter` on a metadata
 * field and the profile's `personFilter`. They are checked where a source is
 * defined, against facts the profile does not carry (the source's version and
 * multi-device mode), and left unjudged where a gateway receives a published
 * profile.
 */

import { describe, expect, it } from "vitest";
import { defineProvider, defineSource } from "./define-source.js";
import {
  DOCUMENT_PROFILE_MAX_FILTER_FIELDS,
  documentFieldFilterProblem,
  personFilterProblem,
  validateDocumentEventProfile,
} from "./structured-source.js";
import type { DocumentFieldFilterSpec, PersonFilterSpec } from "@omnesis/types";
import type { DocumentEventProfile, FilterDeclarationContext } from "./structured-source.js";

const LABELS: DocumentFieldFilterSpec = {
  capability: "membership",
  minVersion: 2,
  scope: "global",
  noun: { one: "label", many: "labels" },
  picker: "search",
};

const FOLDERS: DocumentFieldFilterSpec = {
  capability: "tree",
  minVersion: 2,
  scope: "global",
  noun: { one: "folder", many: "folders" },
  levels: [
    { one: "drive", many: "drives" },
    { one: "folder", many: "folders" },
  ],
  picker: "tree",
  inside: { one: "folder", many: "folders" },
};

const CHATS: DocumentFieldFilterSpec = {
  capability: "membership",
  minVersion: 0,
  scope: "global",
  noun: { one: "chat", many: "chats" },
  picker: "search",
  listsMembers: true,
};

const PEOPLE: PersonFilterSpec = {
  minVersion: 0,
  roles: ["sender", "recipient"],
  identifiers: ["email", "domain"],
  maxPeople: 1000,
};

const AT_TWO: FilterDeclarationContext = { outputRevision: 2, partitioned: false };

function profile(
  filters: {
    labels?: unknown;
    folder?: unknown;
    chat?: unknown;
    person?: unknown;
  } = {},
): DocumentEventProfile {
  return {
    documentTypes: ["email"],
    personRoles: ["sender", "recipient", "mentioned"],
    metadataFields: [
      {
        path: "extra.labelIds",
        type: "string-array",
        description: "Ids of the labels on a message.",
        ...(filters.labels !== undefined ? { filter: filters.labels } : {}),
      },
      {
        path: "extra.folderId",
        type: "string",
        description: "Id of the folder a file sits in.",
        ...(filters.folder !== undefined ? { filter: filters.folder } : {}),
      },
      {
        path: "extra.chatId",
        type: "string",
        description: "Id of the chat a message belongs to.",
        ...(filters.chat !== undefined ? { filter: filters.chat } : {}),
      },
      { path: "extra.size", type: "number", description: "Size in bytes." },
    ],
    ...(filters.person !== undefined ? { personFilter: filters.person } : {}),
  } as DocumentEventProfile;
}

function check(declared: DocumentEventProfile, context: FilterDeclarationContext = AT_TWO) {
  return () => validateDocumentEventProfile(declared, "test", context);
}

describe("a field's filter declaration", () => {
  it("accepts a membership field, a tree field and a field that lists members", () => {
    expect(check(profile({ labels: LABELS, folder: FOLDERS, chat: CHATS }))).not.toThrow();
  });

  it("is accepted on a string and on a string-array field", () => {
    expect(documentFieldFilterProblem("string", LABELS, AT_TWO)).toBeNull();
    expect(documentFieldFilterProblem("string-array", LABELS, AT_TWO)).toBeNull();
  });

  it.each(["number", "boolean"])("is refused on a %s field", (type) => {
    expect(documentFieldFilterProblem(type, LABELS, AT_TWO)).toMatch(
      /needs a string or string-array field/,
    );
  });

  it("names the field it is refused on", () => {
    const declared = profile();
    declared.metadataFields![3]!.filter = LABELS;
    expect(check(declared)).toThrow(
      /test: documentEventProfile field 'extra.size' filter needs a string or string-array field/,
    );
  });

  it("is refused when it is not an object", () => {
    expect(check(profile({ labels: "membership" }))).toThrow(/filter must be an object/);
  });

  it("is refused for a capability the gateway does not have", () => {
    expect(check(profile({ labels: { ...LABELS, capability: "date-range" } }))).toThrow(
      /unsupported capability 'date-range'/,
    );
  });

  it("is refused for the person capability, which belongs to personFilter", () => {
    expect(check(profile({ labels: { ...LABELS, capability: "person" } }))).toThrow(
      /cannot use the 'person' capability/,
    );
  });

  describe("minVersion", () => {
    it.each([0, 1, 2])("accepts %i for a source at version 2", (minVersion) => {
      expect(check(profile({ labels: { ...LABELS, minVersion } }))).not.toThrow();
    });

    it("is refused above the source's version", () => {
      expect(check(profile({ labels: { ...LABELS, minVersion: 3 } }))).toThrow(
        /minVersion 3 is above the source's outputRevision 2/,
      );
    });

    it.each([
      ["negative", -1],
      ["fractional", 1.5],
      ["a string", "1"],
      ["missing", undefined],
    ])("is refused when %s", (_label, minVersion) => {
      expect(check(profile({ labels: { ...LABELS, minVersion } }))).toThrow(
        /minVersion must be an integer >= 0/,
      );
    });
  });

  describe("scope", () => {
    it("accepts device on a partitioned source", () => {
      expect(
        check(profile({ labels: { ...LABELS, scope: "device" } }), {
          outputRevision: 2,
          partitioned: true,
        }),
      ).not.toThrow();
    });

    it("refuses device on a source that is not partitioned", () => {
      expect(check(profile({ labels: { ...LABELS, scope: "device" } }))).toThrow(
        /scope 'device' needs a source whose multiDevice mode is 'partitioned'/,
      );
    });

    it("does not check device where the multi-device mode is not known", () => {
      expect(
        documentFieldFilterProblem("string", { ...LABELS, scope: "device" }, { outputRevision: 2 }),
      ).toBeNull();
    });

    it("refuses any other value", () => {
      expect(check(profile({ labels: { ...LABELS, scope: "account" } }))).toThrow(
        /scope must be 'global' or 'device'/,
      );
    });
  });

  describe("picker and tree-only keys", () => {
    it("refuses a tree picker on a membership field", () => {
      expect(check(profile({ labels: { ...LABELS, picker: "tree" } }))).toThrow(
        /picker 'tree' needs the 'tree' capability/,
      );
    });

    it("accepts a search picker on a tree field", () => {
      expect(check(profile({ folder: { ...FOLDERS, picker: "search" } }))).not.toThrow();
    });

    it("refuses an unknown picker", () => {
      expect(check(profile({ labels: { ...LABELS, picker: "grid" } }))).toThrow(
        /picker must be 'search' or 'tree'/,
      );
    });

    it("refuses levels on a membership field", () => {
      expect(check(profile({ labels: { ...LABELS, levels: FOLDERS.levels } }))).toThrow(
        /levels needs the 'tree' capability/,
      );
    });

    it("refuses inside on a membership field", () => {
      expect(check(profile({ labels: { ...LABELS, inside: FOLDERS.inside } }))).toThrow(
        /inside needs the 'tree' capability/,
      );
    });

    it("refuses an empty levels list", () => {
      expect(check(profile({ folder: { ...FOLDERS, levels: [] } }))).toThrow(
        /levels must be a non-empty list of nouns/,
      );
    });

    it("refuses more levels than a tree may name", () => {
      const levels = Array.from({ length: 9 }, () => ({ one: "folder", many: "folders" }));
      expect(check(profile({ folder: { ...FOLDERS, levels } }))).toThrow(/more than 8 depths/);
    });

    it("refuses a malformed level noun, naming its position", () => {
      const levels = [{ one: "drive", many: "drives" }, { one: "folder" }];
      expect(check(profile({ folder: { ...FOLDERS, levels } }))).toThrow(
        /levels\[1\]\.many must be a non-empty string/,
      );
    });
  });

  describe("nouns", () => {
    it.each([
      ["missing", undefined, /noun must be a noun with 'one' and 'many'/],
      ["a bare string", "label", /noun must be a noun with 'one' and 'many'/],
      ["blank", { one: " ", many: "labels" }, /noun\.one must be a non-empty string/],
      ["without a plural", { one: "label" }, /noun\.many must be a non-empty string/],
      [
        "too long",
        { one: "label", many: "l".repeat(41) },
        /noun\.many is longer than 40 characters/,
      ],
    ])("refuses a noun that is %s", (_label, noun, message) => {
      expect(check(profile({ labels: { ...LABELS, noun } }))).toThrow(message);
    });

    it("refuses a malformed inside noun", () => {
      expect(check(profile({ folder: { ...FOLDERS, inside: { one: "", many: "x" } } }))).toThrow(
        /inside\.one must be a non-empty string/,
      );
    });
  });

  it("refuses a listsMembers that is not a boolean", () => {
    expect(check(profile({ chat: { ...CHATS, listsMembers: "yes" } }))).toThrow(
      /listsMembers must be a boolean/,
    );
  });

  it("allows up to eight filterable fields and refuses a ninth", () => {
    const fields = (count: number): DocumentEventProfile => ({
      metadataFields: Array.from({ length: count }, (_, index) => ({
        path: `extra.group${index}`,
        type: "string" as const,
        description: "An id.",
        filter: LABELS,
      })),
    });
    expect(DOCUMENT_PROFILE_MAX_FILTER_FIELDS).toBe(8);
    expect(check(fields(8))).not.toThrow();
    expect(check(fields(9))).toThrow(/more than 8 filterable fields/);
  });
});

describe("a profile's personFilter", () => {
  it("accepts roles the profile populates and identifiers the gateway knows", () => {
    expect(check(profile({ person: PEOPLE }))).not.toThrow();
  });

  it("is refused when it is not an object", () => {
    expect(check(profile({ person: [] }))).toThrow(/personFilter must be an object/);
  });

  it("is refused above the source's version", () => {
    expect(check(profile({ person: { ...PEOPLE, minVersion: 3 } }))).toThrow(
      /personFilter minVersion 3 is above the source's outputRevision 2/,
    );
  });

  it.each([
    ["an empty role list", { roles: [] }, /roles must be a non-empty list/],
    ["an unknown role", { roles: ["sender", "boss"] }, /unsupported role 'boss'/],
    ["the mentioned role", { roles: ["mentioned"] }, /cannot use the 'mentioned' role/],
    ["a repeated role", { roles: ["sender", "sender"] }, /lists role 'sender' twice/],
    [
      "a role the profile does not populate",
      { roles: ["attendee"] },
      /role 'attendee', which the profile's personRoles does not declare/,
    ],
    ["an empty identifier list", { identifiers: [] }, /identifiers must be a non-empty list/],
    ["an unknown identifier", { identifiers: ["handle"] }, /unsupported identifier 'handle'/],
    [
      "a repeated identifier",
      { identifiers: ["email", "email"] },
      /lists identifier 'email' twice/,
    ],
    ["a zero maxPeople", { maxPeople: 0 }, /maxPeople must be an integer >= 1/],
    ["a fractional maxPeople", { maxPeople: 2.5 }, /maxPeople must be an integer >= 1/],
  ])("is refused with %s", (_label, patch, message) => {
    expect(check(profile({ person: { ...PEOPLE, ...patch } }))).toThrow(message);
  });

  describe("membersOf", () => {
    it("accepts a filterable field whose list carries members", () => {
      expect(
        check(profile({ chat: CHATS, person: { ...PEOPLE, membersOf: "extra.chatId" } })),
      ).not.toThrow();
    });

    it.each([
      ["a path the profile does not declare", "extra.roomId", {}],
      ["a field that is not filterable", "extra.chatId", {}],
      ["a filterable field without listsMembers", "extra.labelIds", { labels: LABELS }],
    ])("is refused for %s", (_label, membersOf, filters) => {
      expect(check(profile({ ...filters, person: { ...PEOPLE, membersOf } }))).toThrow(
        new RegExp(`membersOf names '${membersOf}', which is not a filterable field`),
      );
    });
  });

  it("is judged as plain data, so a stored profile can be checked without trusting it", () => {
    expect(personFilterProblem(null, {}, AT_TWO)).toBe("must be an object");
    expect(
      personFilterProblem(
        { ...PEOPLE, membersOf: "extra.chatId" },
        { metadataFields: [7] },
        {
          outputRevision: 2,
        },
      ),
    ).toMatch(/uses role 'sender'/);
  });
});

describe("where filter declarations are checked", () => {
  it("leaves them unjudged when no source facts are given", () => {
    const declared = profile({
      labels: { capability: "date-range", from: "anything" },
      person: { minVersion: 99 },
    });
    expect(() => validateDocumentEventProfile(declared, "test")).not.toThrow();
  });

  it("still checks the rest of the profile when none are given", () => {
    const declared = profile({ labels: { capability: "date-range" } });
    declared.documentTypes = ["Email"];
    expect(() => validateDocumentEventProfile(declared, "test")).toThrow(/documentType 'Email'/);
  });
});

describe("definition-time enforcement", () => {
  const create = () =>
    Promise.resolve({
      sync: () =>
        Promise.resolve({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
    });
  const base = { name: "Example", description: "Example", authType: "local" as const, create };

  it("a source that declares no version is at version 1", () => {
    expect(() =>
      defineSource({
        ...base,
        id: "mailbox",
        documentEventProfile: profile({ labels: { ...LABELS, minVersion: 1 } }),
      }),
    ).not.toThrow();
    expect(() =>
      defineSource({ ...base, id: "mailbox", documentEventProfile: profile({ labels: LABELS }) }),
    ).toThrow(/minVersion 2 is above the source's outputRevision 1/);
  });

  it("defineSource reads the version from the contract", () => {
    const def = defineSource({
      ...base,
      id: "mailbox",
      contract: { outputRevision: 2 },
      documentEventProfile: profile({ labels: LABELS, person: PEOPLE }),
    });
    expect(def.documentEventProfile?.metadataFields?.[0]?.filter).toEqual(LABELS);
    expect(def.documentEventProfile?.personFilter).toEqual(PEOPLE);
  });

  it("defineSource allows a device scope only on a partitioned source", () => {
    const documentEventProfile = profile({ labels: { ...LABELS, minVersion: 1, scope: "device" } });
    expect(() =>
      defineSource({
        ...base,
        id: "sessions",
        multiDevice: { mode: "partitioned" },
        documentEventProfile,
      }),
    ).not.toThrow();
    expect(() =>
      defineSource({
        ...base,
        id: "sessions",
        multiDevice: { mode: "replicated" },
        documentEventProfile,
      }),
    ).toThrow(/scope 'device' needs a source whose multiDevice mode is 'partitioned'/);
    expect(() => defineSource({ ...base, id: "sessions", documentEventProfile })).toThrow(
      /scope 'device'/,
    );
  });

  it("defineProvider resolves an entry's version and mode through the provider's", () => {
    const entry = {
      id: "workspace-files",
      name: "Workspace files",
      description: "Example",
      create,
      documentEventProfile: profile({ folder: { ...FOLDERS, scope: "device" } }),
    };
    const provider = {
      provider: { id: "workspace", name: "Workspace" },
      authType: "local" as const,
      createContext: () => Promise.resolve({}),
    };
    expect(() =>
      defineProvider({
        ...provider,
        contract: { outputRevision: 2 },
        multiDevice: { mode: "partitioned" },
        sources: [entry],
      }),
    ).not.toThrow();
    expect(() =>
      defineProvider({
        ...provider,
        contract: { outputRevision: 2 },
        multiDevice: { mode: "partitioned" },
        sources: [{ ...entry, multiDevice: { mode: "exclusive" } }],
      }),
    ).toThrow(/defineProvider source 'workspace-files': documentEventProfile .* scope 'device'/);
    expect(() =>
      defineProvider({
        ...provider,
        multiDevice: { mode: "partitioned" },
        sources: [{ ...entry, contract: { outputRevision: 1 } }],
      }),
    ).toThrow(/minVersion 2 is above the source's outputRevision 1/);
  });
});

describe("resyncCost", () => {
  const create = () =>
    Promise.resolve({
      sync: () =>
        Promise.resolve({ documents: [], deletedExternalIds: [], cursor: {}, hasMore: false }),
    });
  const base = {
    id: "mailbox",
    name: "Mailbox",
    description: "Example",
    authType: "local" as const,
    create,
  };

  it("is carried on the definition", () => {
    const sentence = "This reads about 95,000 messages a day.";
    expect(defineSource({ ...base, resyncCost: sentence }).resyncCost).toBe(sentence);
    expect(defineSource(base).resyncCost).toBeUndefined();
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["padded", " This reads every message again. "],
    ["on two lines", "This reads every message again.\nIt takes a day."],
    ["too long", "x".repeat(201)],
  ])("is refused when %s", (_label, resyncCost) => {
    expect(() => defineSource({ ...base, resyncCost })).toThrow(
      /defineSource\('mailbox'\): 'resyncCost' must be one sentence/,
    );
  });

  it("is checked on each source of a provider", () => {
    expect(() =>
      defineProvider({
        provider: { id: "workspace", name: "Workspace" },
        authType: "local",
        createContext: () => Promise.resolve({}),
        sources: [
          { id: "workspace-mail", name: "Mail", description: "Example", create, resyncCost: "" },
        ],
      }),
    ).toThrow(/defineProvider source 'workspace-mail': 'resyncCost'/);
  });
});
