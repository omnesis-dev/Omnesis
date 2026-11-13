// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScopeFactsDocumentTriggers } from "./scope-schema.js";
import { createScopeDescriptorsSchema, upsertSourceScopes } from "./scope-descriptors.js";
import { projectStoredDocumentScopes } from "./scope-projection.js";
import { applyConversationScopeUpdates } from "./scope-conversations.js";
import { scopePersonIdentifiers } from "./scope-editor-people.js";
import { parseScopePolicyV1 } from "./scope-policy.js";
import { documentScopeFactsSchema } from "./scope-update-schema.js";
import { sourceScopeInclusionSql } from "./scope-sql.js";
import type {
  DocumentMetadata,
  PersonMention,
  ScopeIdentifier,
  SourceScopes,
} from "@omnesis/types";

const chat: SourceScopes = {
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
    participants: { roles: ["participant"], membership: "conversation" },
  },
};
const mail: SourceScopes = {
  items: [{ kind: "participant", identifiers: ["email", "domain"], link: "fixed" }],
  legacyProjection: {
    participants: { roles: ["sender", "recipient"], membership: "document" },
  },
};

/**
 * A filter matches by string equality between what the owner saved and what a
 * source declared. Each case writes the two sides the way their own code path
 * does — a typed or picked identifier through the policy boundary, a source's
 * mention through the fact projection — and asks the enforcement predicate.
 */
describe("typed filter identifiers agree with source-declared facts", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`CREATE TABLE sources(id TEXT PRIMARY KEY,type TEXT,multi_device_mode TEXT);
      INSERT INTO sources VALUES('chat:one','chat','exclusive'),('mail:one','mail','exclusive');
      CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,provider_id TEXT,stream_id TEXT,external_id TEXT,metadata TEXT,updated_at TEXT);
      CREATE UNIQUE INDEX docs_external ON documents(provider_id,source_id,stream_id,external_id);
      CREATE TABLE people(id TEXT PRIMARY KEY,merged_into TEXT);
      CREATE TABLE person_aliases(person_id TEXT,alias_type TEXT,alias TEXT)`);
    createScopeDescriptorsSchema(db);
    createScopeFactsDocumentTriggers(db);
    upsertSourceScopes(
      db,
      [
        { sourceType: "chat", scopes: chat },
        { sourceType: "mail", scopes: mail },
      ],
      1,
    );
    for (const [id, type] of [
      ["chat:one", "chat"],
      ["mail:one", "mail"],
    ])
      db.prepare(
        "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES(?,?,'{}',1)",
      ).run(id, type);
  });
  afterEach(() => db.close());

  function store(sourceId: string, scopes: SourceScopes, id: string, metadata: DocumentMetadata) {
    const providerId = sourceId.split(":")[0]!;
    db.prepare("INSERT INTO documents VALUES(?,?,?,'',?,?,'2026-01-01')").run(
      id,
      sourceId,
      providerId,
      id,
      JSON.stringify(metadata),
    );
    projectStoredDocumentScopes(
      db,
      { id, sourceId, providerId, streamId: "", externalId: id, metadata },
      scopes,
    );
  }
  function conversation(id: string, participants: PersonMention[]) {
    store("chat:one", chat, `${id}-day`, {
      documentType: "conversation",
      extra: { conversationId: id },
    });
    applyConversationScopeUpdates(
      db,
      {
        sourceId: "chat:one",
        providerId: "chat",
        streamId: "",
        writeEpoch: 1,
        snapshotAuthority: true,
      },
      [
        {
          id,
          participants,
          mode: "snapshot",
          observedAt: "2026-01-01T00:00:00.000Z",
          revision: { epoch: "native", sequence: 1 },
        },
      ],
    );
  }
  function email(id: string, people: PersonMention[]) {
    store("mail:one", mail, id, { documentType: "email", people });
  }
  function visible(
    sourceId: string,
    scopes: SourceScopes,
    action: "share" | "hide",
    typed: Array<{ type: ScopeIdentifier["type"]; value: string }>,
  ): string[] {
    const policy = parseScopePolicyV1(
      {
        sourceId,
        audience: { accessLevel: "level", capability: "direct" },
        rules: [
          { action, match: [{ kind: "participant", label: "As typed", identifiers: typed }] },
        ],
        otherwise: action === "share" ? "hide" : "share",
      },
      scopes,
    );
    const restriction = sourceScopeInclusionSql([policy], "d.id", "d.source_id");
    return db
      .prepare<string[], { id: string }>(
        `SELECT d.id FROM documents d WHERE d.source_id=? AND ${restriction.sql} ORDER BY d.id`,
      )
      .all(sourceId, ...restriction.params)
      .map((row) => row.id);
  }

  it.each([
    "+12025550123",
    "+1 (202) 555-0123",
    "+1 202-555-0123",
    "+1.202.555.0123",
    "0012025550123",
    "+1 202 555 0123",
    "tel:+12025550123",
  ])("a phone number typed as %j shares and hides the conversation a source declared", (typed) => {
    conversation("with-maya", [
      { role: "participant", isSelf: true, identifiers: [] },
      { role: "participant", identifiers: [{ kind: "phone", value: "+12025550123" }] },
    ]);
    conversation("with-jamie", [
      { role: "participant", isSelf: true, identifiers: [] },
      { role: "participant", phones: ["+12025550145"] },
    ]);
    const identifiers = [{ type: "phone" as const, value: typed }];
    expect(visible("chat:one", chat, "share", identifiers)).toEqual(["with-maya-day"]);
    expect(visible("chat:one", chat, "hide", identifiers)).toEqual(["with-jamie-day"]);
  });

  it.each(["+1 (202) 555-0123", "+1 202 555 0123", "001 202 555 0123"])(
    "a source that declares %j still meets the number saved in its canonical form",
    (declared) => {
      conversation("with-maya", [{ role: "participant", phones: [declared] }]);
      const identifiers = [{ type: "phone" as const, value: "+12025550123" }];
      expect(visible("chat:one", chat, "share", identifiers)).toEqual(["with-maya-day"]);
      expect(visible("chat:one", chat, "hide", identifiers)).toEqual([]);
    },
  );

  it.each(["12025550123", "(202) 555-0123", "12025550123@s.whatsapp.net"])(
    "a member declared without a country code as %j leaves the conversation unknown, hidden either way",
    (declared) => {
      conversation("unaddressable", [{ role: "participant", phones: [declared] }]);
      const identifiers = [{ type: "phone" as const, value: "+12025550123" }];
      expect(visible("chat:one", chat, "share", identifiers)).toEqual([]);
      expect(visible("chat:one", chat, "hide", identifiers)).toEqual([]);
    },
  );

  it("an opaque member with no phone number keeps the whole conversation unknown", () => {
    conversation("opaque", [
      { role: "participant", phones: ["+12025550145"] },
      { role: "participant", identifiers: [{ kind: "lid", value: "whatsapp:224466880011" }] },
    ]);
    const identifiers = [{ type: "phone" as const, value: "+12025550123" }];
    expect(visible("chat:one", chat, "share", identifiers)).toEqual([]);
    expect(visible("chat:one", chat, "hide", identifiers)).toEqual([]);
  });

  it("an opaque member mapped to a phone number is matched by that number", () => {
    conversation("mapped", [
      {
        role: "participant",
        identifiers: [
          { kind: "phone", value: "+12025550123" },
          { kind: "lid", value: "whatsapp:224466880011" },
        ],
      },
    ]);
    const identifiers = [{ type: "phone" as const, value: "+1 202 555 0123" }];
    expect(visible("chat:one", chat, "share", identifiers)).toEqual(["mapped-day"]);
    expect(visible("chat:one", chat, "hide", identifiers)).toEqual([]);
  });

  it("a handle that is an email address is matched however its case was typed", () => {
    conversation("by-email", [{ role: "participant", emails: ["Maya.Reeves@Example.org"] }]);
    const identifiers = [{ type: "email" as const, value: "MAYA.REEVES@example.ORG " }];
    expect(visible("chat:one", chat, "share", identifiers)).toEqual(["by-email-day"]);
    expect(visible("chat:one", chat, "hide", identifiers)).toEqual([]);
  });

  it.each([
    ["Maya@Example.ORG", "maya@example.org"],
    ["maya@example.org", "Maya Reeves <MAYA@example.org>"],
    ["maya@example.org", "mailto:maya@example.org"],
    ["maya@example.org.", "maya@example.org"],
    ["fictional.scope.check+filter@gmail.com", "FictionalScopeCheck@gmail.com"],
    ["fictionalscopecheck@googlemail.com", "fictional.scope.check@gmail.com"],
    ["o'neil&co=7@example.org", "O'Neil&Co=7@example.org"],
    ["maya@bücher.example", "maya@xn--bcher-kva.example"],
    ["maya@xn--bcher-kva.example", "maya@BÜCHER.example"],
  ])("mail declared from %j meets the address typed as %j", (declared, typed) => {
    email("from-maya", [
      { role: "sender", emails: [declared] },
      { role: "recipient", isSelf: true, emails: ["owner@example.org"] },
    ]);
    email("from-jamie", [
      { role: "sender", emails: ["jamie@example.net"] },
      { role: "recipient", isSelf: true, emails: ["owner@example.org"] },
    ]);
    const identifiers = [{ type: "email" as const, value: typed }];
    expect(visible("mail:one", mail, "share", identifiers)).toEqual(["from-maya"]);
    expect(visible("mail:one", mail, "hide", identifiers)).toEqual(["from-jamie"]);
  });

  it("plus-addressing is a different address outside the providers that fold it", () => {
    email("tagged", [{ role: "sender", emails: ["maya+receipts@example.org"] }]);
    email("plain", [{ role: "sender", emails: ["maya@example.org"] }]);
    const identifiers = [{ type: "email" as const, value: "maya@example.org" }];
    expect(visible("mail:one", mail, "share", identifiers)).toEqual(["plain"]);
    expect(visible("mail:one", mail, "hide", identifiers)).toEqual(["tagged"]);
  });

  it.each(["example.org", "EXAMPLE.org", "@example.org", "example.org."])(
    "the domain typed as %j is one exact host name: never a subdomain, a suffix or a lookalike",
    (typed) => {
      email("exact", [{ role: "sender", emails: ["Maya@Example.ORG"] }]);
      email("subdomain", [{ role: "sender", emails: ["maya@mail.example.org"] }]);
      email("lookalike", [{ role: "sender", emails: ["maya@notexample.org"] }]);
      email("suffix", [{ role: "sender", emails: ["maya@example.org.example.net"] }]);
      const identifiers = [{ type: "domain" as const, value: typed }];
      expect(visible("mail:one", mail, "share", identifiers)).toEqual(["exact"]);
      expect(visible("mail:one", mail, "hide", identifiers)).toEqual([
        "lookalike",
        "subdomain",
        "suffix",
      ]);
    },
  );

  it("a person in To, Cc or Bcc counts; an address only quoted in the body does not", () => {
    email("to", [
      { role: "sender", emails: ["jamie@example.net"] },
      { role: "recipient", emails: ["maya@example.org"] },
    ]);
    email("body-only", [
      { role: "sender", emails: ["jamie@example.net"] },
      { role: "mentioned", emails: ["maya@example.org"] },
    ]);
    const identifiers = [{ type: "email" as const, value: "maya@example.org" }];
    expect(visible("mail:one", mail, "share", identifiers)).toEqual(["to"]);
    expect(visible("mail:one", mail, "hide", identifiers)).toEqual(["body-only"]);
  });

  it("a participant with no usable address leaves the message unknown, hidden either way", () => {
    email("malformed", [
      { role: "sender", emails: ["jamie@example.net"] },
      { role: "recipient", emails: ["undisclosed-recipients"] },
    ]);
    const identifiers = [{ type: "email" as const, value: "maya@example.org" }];
    expect(visible("mail:one", mail, "share", identifiers)).toEqual([]);
    expect(visible("mail:one", mail, "hide", identifiers)).toEqual([]);
  });

  it("a source's explicit facts take the same spelling as a typed filter", () => {
    const parsed = documentScopeFactsSchema.parse({
      facts: [
        { kind: "participant", identifier: { type: "phone", value: "+1 (202) 555-0123" } },
        { kind: "participant", identifier: { type: "email", value: "Maya@Example.ORG" } },
      ],
      complete: ["participant"],
    });
    expect(parsed.facts).toEqual([
      { kind: "participant", identifier: { type: "phone", value: "+12025550123" } },
      { kind: "participant", identifier: { type: "email", value: "maya@example.org" } },
    ]);
  });

  it("picking a person snapshots every address a source could declare for them", () => {
    db.prepare("INSERT INTO people VALUES('maya',NULL),('maya-old','maya')").run();
    const alias = db.prepare("INSERT INTO person_aliases VALUES(?,?,?)");
    alias.run("maya", "phone", "+12025550123");
    alias.run("maya", "phone", "+1 (202) 555-0145");
    alias.run("maya", "phone", "202-555-0199");
    alias.run("maya", "email", "o'neil&co=7@example.org");
    alias.run("maya-old", "email", "Maya@BÜCHER.example");
    alias.run("maya", "name", "Maya Reeves");
    expect(scopePersonIdentifiers(db, "maya", chat)).toEqual([
      { type: "email", value: "maya@xn--bcher-kva.example" },
      { type: "email", value: "o'neil&co=7@example.org" },
      { type: "phone", value: "+12025550145" },
      { type: "phone", value: "+12025550123" },
    ]);
  });
});
