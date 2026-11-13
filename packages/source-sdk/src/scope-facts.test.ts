// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  documentScopeParent,
  projectDocumentScopeFacts,
  projectNativeScopeParticipants,
} from "./scope-facts.js";
import type { SourceScopes } from "@omnesis/types";

const scopes: SourceScopes = {
  items: [
    {
      kind: "conversation",
      noun: { one: "conversation", many: "conversations" },
      picker: "search",
      link: "fixed",
    },
    { kind: "participant", identifiers: ["phone", "email"], link: "changes" },
  ],
  legacyProjection: {
    conversationIdPath: ["extra", "conversationId"],
    participants: { roles: ["sender", "recipient"], membership: "document" },
  },
};

describe("projectNativeScopeParticipants", () => {
  it("keeps a conversation complete when only the account owner has no address", () => {
    const result = projectNativeScopeParticipants(
      [
        { role: "sender", isSelf: true, identifiers: [] },
        { role: "recipient", identifiers: [{ kind: "phone", value: "+12025550101" }] },
      ],
      scopes,
    );
    expect(result.complete).toBe(true);
    expect(result.participants).toEqual([
      {
        nativeKey: "phone:+12025550101",
        identifiers: [{ type: "phone", value: "+12025550101" }],
        complete: true,
      },
    ]);
  });
  it("still projects an account owner the source can address", () => {
    const result = projectNativeScopeParticipants(
      [{ role: "sender", isSelf: true, emails: ["owner@example.org"] }],
      scopes,
    );
    expect(result.complete).toBe(true);
    expect(result.participants.map((participant) => participant.nativeKey)).toEqual([
      "email:owner@example.org",
    ]);
  });
  it("keeps any other participant without an address unknown", () => {
    const result = projectNativeScopeParticipants(
      [
        { role: "sender", isSelf: true, identifiers: [] },
        { role: "recipient", identifiers: [] },
      ],
      scopes,
    );
    expect(result.complete).toBe(false);
    expect(result.participants).toEqual([{ nativeKey: null, identifiers: [], complete: false }]);
  });
  it("does not call a conversation complete when the owner without an address is all it names", () => {
    expect(
      projectNativeScopeParticipants([{ role: "sender", isSelf: true, identifiers: [] }], scopes),
    ).toEqual({ participants: [], complete: false });
  });
});

describe("projectDocumentScopeFacts", () => {
  it("merges explicit native kinds without losing unrelated legacy participant facts", () => {
    const declared: SourceScopes = {
      ...scopes,
      items: [
        ...scopes.items,
        {
          kind: "label",
          noun: { one: "label", many: "labels" },
          picker: "search",
          link: "changes",
        },
      ],
    };
    const result = projectDocumentScopeFacts(
      {
        people: [{ role: "sender", emails: ["maya@example.org"] }],
        scopeFacts: { facts: [{ kind: "label", id: "Label_native" }], complete: ["label"] },
      },
      declared,
    );
    expect(result.complete).toEqual(["participant", "label"]);
    expect(result.facts).toContainEqual({
      kind: "participant",
      identifier: { type: "email", value: "maya@example.org" },
    });
    expect(
      projectDocumentScopeFacts(
        {
          people: [{ role: "sender", emails: ["maya@example.org"] }],
          scopeFacts: { kinds: ["participant"], facts: [], complete: [] },
        },
        scopes,
      ),
    ).toEqual({ facts: [], complete: [] });
  });

  it("uses original native identifiers, excludes body mentions, and deduplicates", () => {
    expect(
      projectDocumentScopeFacts(
        {
          extra: { conversationId: "fictional-thread" },
          people: [
            { role: "sender", identifiers: [{ kind: "email", value: " MAYA@example.org " }] },
            { role: "recipient", emails: ["maya@example.org"], phones: ["+44 7700 900123"] },
            { role: "mentioned", emails: ["jamie@example.org"] },
          ],
        },
        scopes,
      ),
    ).toEqual({
      facts: [
        { kind: "conversation", id: "fictional-thread" },
        { kind: "participant", identifier: { type: "email", value: "maya@example.org" } },
        { kind: "participant", identifier: { type: "phone", value: "+447700900123" } },
      ],
      complete: ["conversation", "participant"],
    });
  });

  it("retains positive facts while an unresolved participant makes the kind incomplete", () => {
    const projected = projectDocumentScopeFacts(
      {
        people: [
          { role: "sender", emails: ["maya@example.org"] },
          { role: "recipient", lids: ["whatsapp:opaque-person"] },
        ],
      },
      scopes,
    );
    expect(projected.facts).toEqual([
      { kind: "participant", identifier: { type: "email", value: "maya@example.org" } },
    ]);
    expect(projected.complete).toEqual([]);
  });

  it("withholds completeness at a producer's metadata truncation limit", () => {
    const capped: SourceScopes = {
      ...scopes,
      legacyProjection: {
        participants: { roles: ["sender", "recipient"], membership: "document", maxPeople: 2 },
      },
    };
    const projected = projectDocumentScopeFacts(
      {
        people: [
          { role: "sender", emails: ["maya@example.org"] },
          { role: "recipient", emails: ["jamie@example.org"] },
        ],
      },
      capped,
    );
    expect(projected.facts).toHaveLength(2);
    expect(projected.complete).toEqual([]);
  });

  it("keeps saved email matching independent of provider-specific alias folding", () => {
    expect(
      projectDocumentScopeFacts(
        { people: [{ role: "sender", emails: ["Cedar.Project+receipt@example.org"] }] },
        scopes,
      ).facts,
    ).toContainEqual({
      kind: "participant",
      identifier: {
        type: "email",
        value: "cedar.project+receipt@example.org",
      },
    });
  });

  it("does not claim complete conversation membership from one day's speakers", () => {
    const conversationScopes: SourceScopes = {
      ...scopes,
      legacyProjection: {
        ...scopes.legacyProjection,
        participants: { roles: ["participant"], membership: "conversation" },
      },
    };
    const projected = projectDocumentScopeFacts(
      {
        extra: { conversationId: "fictional-group" },
        people: [{ role: "participant", emails: ["maya@example.org"] }],
      },
      conversationScopes,
    );
    expect(projected.complete).toEqual(["conversation"]);
    expect(projected.facts).toContainEqual({
      kind: "participant",
      identifier: { type: "email", value: "maya@example.org" },
    });
  });

  it.each([
    {},
    { people: [] },
    { people: [{ role: "sender" as const, emails: ["not-an-email"] }] },
  ])("keeps missing or unusable native identities incomplete: %j", (metadata) => {
    expect(projectDocumentScopeFacts(metadata, scopes)).toEqual({ facts: [], complete: [] });
  });

  it("does not infer stable label IDs or folder ancestry from display metadata", () => {
    expect(
      projectDocumentScopeFacts(
        { tags: ["Personal"], extra: { folderPath: "/Cedar", conversationId: "fictional" } },
        {
          items: [
            {
              kind: "folder",
              noun: { one: "folder", many: "folders" },
              picker: "tree",
              link: "hierarchy",
            },
          ],
        },
      ),
    ).toEqual({ facts: [], complete: [] });
  });

  it("accepts only identifier kinds the provider declares", () => {
    expect(
      projectDocumentScopeFacts(
        { people: [{ role: "sender", emails: ["maya@example.org"] }] },
        { ...scopes, items: [{ kind: "participant", identifiers: ["phone"], link: "changes" }] },
      ),
    ).toEqual({ facts: [], complete: [] });
  });
  it("bounds legacy alias bags and withholds completeness when identities are truncated", () => {
    const result = projectDocumentScopeFacts(
      {
        people: [
          {
            role: "sender",
            emails: Array.from({ length: 100 }, (_, index) => `alias${index}@example.org`),
          },
        ],
      },
      scopes,
    );
    expect(result.facts).toHaveLength(16);
    expect(result.complete).toEqual([]);
  });
});

describe("documentScopeParent", () => {
  it("names the one item a document sits in, under the refresh it was observed in", () => {
    expect(documentScopeParent("item-1")).toEqual({
      kind: "folder",
      parentIds: ["item-1"],
      complete: true,
    });
    expect(documentScopeParent("item-1", "epoch-2").refreshEpoch).toBe("epoch-2");
  });

  it("reports a document with no item as not known, never as the top of the tree", () => {
    for (const missing of [undefined, null, ""])
      expect(documentScopeParent(missing, "epoch-2")).toEqual({
        kind: "folder",
        parentIds: [],
        complete: false,
        refreshEpoch: "epoch-2",
      });
  });
});
