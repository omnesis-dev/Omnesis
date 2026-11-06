// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createScopeDescriptorsSchema,
  getSourceScopes,
  listSourceScopes,
  sourceScopesSchema,
  upsertSourceScopes,
} from "./scope-descriptors.js";
import type { SourceScopes } from "@omnesis/types";

const conversations: SourceScopes = {
  items: [
    {
      kind: "conversation",
      noun: { one: "conversation", many: "conversations" },
      picker: "search",
      link: "fixed",
    },
  ],
  legacyProjection: { conversationIdPath: ["extra", "conversationId"] },
};
const people: SourceScopes = {
  items: [{ kind: "participant", identifiers: ["email", "domain"], link: "changes" }],
  legacyProjection: { participants: { roles: ["sender", "recipient"], membership: "document" } },
};

describe("persisted source scope declarations", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    createScopeDescriptorsSchema(db);
  });
  afterEach(() => db.close());

  it("merges collectors' platform-specific declarations and survives reopening a handle", () => {
    expect(getSourceScopes(db, "fictional-chat")).toBeNull();
    expect(
      upsertSourceScopes(db, [{ sourceType: "fictional-chat", scopes: conversations }], 1),
    ).toEqual({ stored: 1 });
    upsertSourceScopes(db, [{ sourceType: "fictional-mail", scopes: people }], 2);
    createScopeDescriptorsSchema(db);
    expect(listSourceScopes(db)).toEqual([
      { sourceType: "fictional-chat", scopes: conversations },
      { sourceType: "fictional-mail", scopes: people },
    ]);
    upsertSourceScopes(db, [{ sourceType: "fictional-chat", scopes: people }], 3);
    expect(getSourceScopes(db, "fictional-chat")).toEqual(people);
  });

  it("validates the entire update before storing anything", () => {
    expect(() =>
      upsertSourceScopes(
        db,
        [
          { sourceType: "fictional-chat", scopes: conversations },
          { sourceType: "invalid", scopes: { items: [] } },
        ],
        1,
      ),
    ).toThrow();
    expect(listSourceScopes(db)).toEqual([]);
    expect(() =>
      upsertSourceScopes(
        db,
        [
          { sourceType: "same", scopes: conversations },
          { sourceType: "same", scopes: people },
        ],
        1,
      ),
    ).toThrow(/Duplicate/);
    expect(listSourceScopes(db)).toEqual([]);
  });

  it("fails closed on corrupt or future unreadable stored descriptors", () => {
    db.prepare("INSERT INTO source_scope_descriptors VALUES (?, ?, ?)").run("broken", "{", 1);
    db.prepare("INSERT INTO source_scope_descriptors VALUES (?, ?, ?)").run(
      "future",
      JSON.stringify({ items: [{ kind: "future" }] }),
      1,
    );
    expect(getSourceScopes(db, "broken")).toBeNull();
    expect(getSourceScopes(db, "future")).toBeNull();
    expect(listSourceScopes(db)).toEqual([]);
  });

  it("rejects duplicate kinds, body mentions, prototype paths and unknown fields", () => {
    for (const input of [
      { ...conversations, items: [...conversations.items, ...conversations.items] },
      {
        ...people,
        legacyProjection: { participants: { roles: ["mentioned"], membership: "document" } },
      },
      {
        ...conversations,
        legacyProjection: { conversationIdPath: ["__proto__", "conversationId"] },
      },
      { ...conversations, unknown: true },
    ])
      expect(sourceScopesSchema.safeParse(input).success).toBe(false);
  });
});
