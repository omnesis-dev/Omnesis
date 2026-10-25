// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDatabase } from "../db.js";
import { upsertSourceDocumentProfiles } from "../data/repositories/SourceDocumentProfileRepository.js";
import { countMessagesByPerson, type MessageCountsQuery } from "./message-counts.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-message-counts-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A chat source that rolls each chat's day into one document. */
const CHAT = "demo-chat:acct";
/** A mail source with one document per message. */
const MAIL = "demo-mail:acct";

function declareChatProfile(): void {
  upsertSourceDocumentProfiles(
    db,
    [
      {
        sourceType: "demo-chat",
        profile: {
          documentTypes: ["conversation"],
          personRoles: ["participant", "mentioned"],
          metadataFields: [
            {
              path: "extra.messageCount",
              type: "number",
              description: "Messages that day.",
              semantics: "message-count",
            },
            {
              path: "extra.isGroup",
              type: "boolean",
              description: "Whether the chat is a group.",
              semantics: "group-conversation",
            },
          ],
        },
      },
      {
        sourceType: "demo-mail",
        profile: { documentTypes: ["email"], personRoles: ["sender", "recipient"] },
      },
    ],
    Date.now(),
  );
}

function person(id: string, name: string, opts: { self?: boolean; mergedInto?: string } = {}) {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, merged_into, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, 'extracted', ?, ?, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, name, opts.self ? 1 : 0, opts.mergedInto ?? null);
}

function doc(
  id: string,
  sourceId: string,
  at: string,
  metadata: Record<string, unknown>,
  people: Array<[personId: string, role: string]>,
): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test', ?, ?, ?, 'body', ?, ?, ?, ?, ?, ?)`,
  ).run(id, sourceId, id, id, `hash-${id}`, JSON.stringify(metadata), at, at, at, at);
  for (const [personId, role] of people) {
    db.prepare(
      "INSERT INTO document_people (document_id, person_id, role, source_id) VALUES (?, ?, ?, ?)",
    ).run(id, personId, role, sourceId);
  }
}

function chatDay(
  id: string,
  at: string,
  count: number,
  others: string[],
  opts: { isGroup?: boolean; mentioned?: string[] } = {},
): void {
  doc(
    id,
    CHAT,
    at,
    {
      documentType: "conversation",
      extra: { messageCount: count, isGroup: opts.isGroup ?? false },
    },
    [
      ["p-self", "participant"],
      ...others.map((o): [string, string] => [o, "participant"]),
      ...(opts.mentioned ?? []).map((o): [string, string] => [o, "mentioned"]),
    ],
  );
}

function email(id: string, at: string, from: string, to: string[]): void {
  doc(id, MAIL, at, { documentType: "email" }, [
    [from, "sender"],
    ...to.map((r): [string, string] => [r, "recipient"]),
  ]);
}

const WEEK: MessageCountsQuery = {
  fromIso: "2026-10-19T00:00:00.000Z",
  toExclusiveIso: "2026-10-26T00:00:00.000Z",
  limit: 10,
};

/**
 * The shape behind a confidently wrong "who did I message most" answer: the
 * person with the most messages has two long chat days, while a search for the
 * week surfaces many shorter documents about other people first.
 */
function seedWeek(): void {
  declareChatProfile();
  person("p-self", "Alex", { self: true });
  person("p-maya", "Maya");
  person("p-maya-mail", "maya@example.com", { mergedInto: "p-maya" });
  person("p-david", "David");
  person("p-jamie", "Jamie");
  person("p-sarah", "Sarah");
  person("p-news", "Weekly digest");
  person("p-quoted", "Landlord");

  // Maya: two long one-to-one days, plus an email the user sent to her alias.
  chatDay("maya-mon", "2026-10-19T08:00:00.000Z", 101, ["p-maya"]);
  chatDay("maya-tue", "2026-10-20T08:00:00.000Z", 94, ["p-maya"], { mentioned: ["p-quoted"] });
  email("mail-to-maya", "2026-10-21T09:00:00.000Z", "p-self", ["p-maya-mail"]);
  // David: one short one-to-one day.
  chatDay("david-wed", "2026-10-21T08:00:00.000Z", 11, ["p-david"]);
  // A busy group: its messages are the group's, not each member's.
  chatDay("group-mon", "2026-10-19T10:00:00.000Z", 71, ["p-jamie", "p-david"], { isGroup: true });
  // A group whose metadata never arrived: two other people still make it one.
  chatDay("group-unflagged", "2026-10-22T10:00:00.000Z", 40, ["p-jamie", "p-sarah"]);
  // Sarah: a short email exchange.
  email("sarah-1", "2026-10-20T12:00:00.000Z", "p-sarah", ["p-self"]);
  email("sarah-2", "2026-10-20T13:00:00.000Z", "p-self", ["p-sarah"]);
  // A newsletter that writes every day and is never answered.
  for (let day = 19; day <= 25; day++) {
    email(`news-${day}`, `2026-10-${day}T06:00:00.000Z`, "p-news", ["p-self"]);
  }
  // Outside the window.
  chatDay("david-last-week", "2026-10-12T08:00:00.000Z", 500, ["p-david"]);
}

describe("countMessagesByPerson", () => {
  test("ranks by messages counted across every document, not by document count", () => {
    seedWeek();
    const result = countMessagesByPerson(db, WEEK);
    const names = result.people.map((p) => p.name);
    expect(names[0]).toBe("Maya");

    const maya = result.people.find((p) => p.personId === "p-maya")!;
    // 101 + 94 chat messages plus one email, through the merged alias.
    expect(maya).toMatchObject({ messages: 196, groupMessages: 0, documents: 3, sentByYou: 1 });

    const david = result.people.find((p) => p.personId === "p-david")!;
    expect(david).toMatchObject({ messages: 11, groupMessages: 71, documents: 2 });
  });

  test("keeps group conversations apart from each member's own count", () => {
    seedWeek();
    const result = countMessagesByPerson(db, WEEK);
    const jamie = result.people.find((p) => p.personId === "p-jamie")!;
    // The flagged group (71) and the unflagged one with two other people (40).
    expect(jamie).toMatchObject({ messages: 0, groupMessages: 111 });
  });

  test("records direction where the source has a sender", () => {
    seedWeek();
    const result = countMessagesByPerson(db, WEEK);
    expect(result.people.find((p) => p.personId === "p-news")).toMatchObject({
      messages: 7,
      sentByThem: 7,
      sentByYou: 0,
    });
    expect(result.people.find((p) => p.personId === "p-sarah")).toMatchObject({
      messages: 2,
      groupMessages: 40,
      sentByThem: 1,
      sentByYou: 1,
    });
  });

  test("never counts the user, mentions, or documents outside the window", () => {
    seedWeek();
    const result = countMessagesByPerson(db, WEEK);
    const ids = result.people.map((p) => p.personId);
    expect(ids).not.toContain("p-self");
    expect(ids).not.toContain("p-maya-mail");
    expect(ids).not.toContain("p-quoted");
    expect(result.selfKnown).toBe(true);
    // Last week's long chat with David is not in this week's count.
    expect(result.people.find((p) => p.personId === "p-david")?.messages).toBe(11);
  });

  test("reports what each source contributed and how it was counted", () => {
    seedWeek();
    const result = countMessagesByPerson(db, WEEK);
    expect(result.sources).toEqual([
      { sourceId: CHAT, documents: 5, messages: 317, countedPer: "declared-count" },
      { sourceId: MAIL, documents: 10, messages: 10, countedPer: "document" },
    ]);
  });

  test("restricts to named sources and caps the list", () => {
    seedWeek();
    const mailOnly = countMessagesByPerson(db, { ...WEEK, sourceIds: [MAIL], limit: 1 });
    expect(mailOnly.people.map((p) => p.name)).toEqual(["Weekly digest"]);
    expect(mailOnly.totalPeople).toBe(3);
    expect(mailOnly.truncated).toBe(true);
    expect(mailOnly.sources.map((s) => s.sourceId)).toEqual([MAIL]);
  });

  test("counts one message per document for a source that declares no count", () => {
    person("p-self", "Alex", { self: true });
    person("p-maya", "Maya");
    // No published profile at all for this source.
    chatDay("undeclared", "2026-10-20T08:00:00.000Z", 250, ["p-maya"]);
    const result = countMessagesByPerson(db, WEEK);
    expect(result.people[0]).toMatchObject({ personId: "p-maya", messages: 1 });
    expect(result.sources[0]?.countedPer).toBe("document");
  });

  test("returns an empty result for a quiet window", () => {
    seedWeek();
    const result = countMessagesByPerson(db, {
      fromIso: "2025-01-01T00:00:00.000Z",
      toExclusiveIso: "2025-01-02T00:00:00.000Z",
      limit: 10,
    });
    expect(result).toEqual({
      people: [],
      totalPeople: 0,
      truncated: false,
      sources: [],
      selfKnown: false,
    });
  });
});
