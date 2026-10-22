// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createCountMessagesTool, type MessageCountPortResult } from "@omnesis/agent";

import { createDatabase } from "../db.js";
import { upsertSourceDocumentProfiles } from "../data/repositories/SourceDocumentProfileRepository.js";
import { countMessagesByPerson, type MessageCountsQuery } from "../domain/message-counts.js";
import { createGatewayMessageCountPort, resolveMessageCountWindow } from "./message-count-port.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-message-count-port-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const iso = (ms: number) => new Date(ms).toISOString();

describe("resolveMessageCountWindow", () => {
  const now = Date.parse("2026-10-22T15:00:00.000Z");

  test("a bare day, month or year covers that period", () => {
    const day = resolveMessageCountWindow({ from: "2026-10-19", timeZone: "UTC" }, now);
    expect([iso(day.fromMs), iso(day.toExclusiveMs)]).toEqual([
      "2026-10-19T00:00:00.000Z",
      "2026-10-20T00:00:00.000Z",
    ]);
    const month = resolveMessageCountWindow({ from: "2026-09", timeZone: "UTC" }, now);
    expect(iso(month.toExclusiveMs)).toBe("2026-10-01T00:00:00.000Z");
  });

  test("any other start without an end runs up to now", () => {
    const week = resolveMessageCountWindow({ from: "-7d", timeZone: "UTC" }, now);
    expect(iso(week.toExclusiveMs)).toBe(iso(now));
    expect(week.fromMs).toBeLessThan(now);
  });

  test("an explicit end is exclusive and read in the caller's zone", () => {
    const window = resolveMessageCountWindow(
      { from: "2026-10-19", to: "2026-10-26", timeZone: "Europe/Paris" },
      now,
    );
    expect([iso(window.fromMs), iso(window.toExclusiveMs)]).toEqual([
      "2026-10-18T22:00:00.000Z",
      "2026-10-25T23:00:00.000Z",
    ]);
  });

  test("a start in the future with no end is refused", () => {
    expect(() =>
      resolveMessageCountWindow({ from: "2026-12-01T00:00:00Z", timeZone: "UTC" }, now),
    ).toThrow(/in the past/);
  });
});

describe("count_messages over the gateway port", () => {
  function seed(): void {
    upsertSourceDocumentProfiles(
      db,
      [
        {
          sourceType: "demo-chat",
          profile: {
            documentTypes: ["conversation"],
            metadataFields: [
              {
                path: "extra.messageCount",
                type: "number",
                description: "Messages that day.",
                semantics: "message-count",
              },
            ],
          },
        },
      ],
      Date.now(),
    );
    const insertPerson = db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES (?, ?, 'extracted', ?, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    );
    insertPerson.run("p-self", "Alex", 1);
    insertPerson.run("p-maya", "Maya", 0);
    insertPerson.run("p-david", "David", 0);
    const insertDoc = db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES (?, 'test', 'demo-chat:acct', ?, ?, 'body', ?, ?, ?, ?, ?, ?)`,
    );
    const insertRole = db.prepare(
      "INSERT INTO document_people (document_id, person_id, role) VALUES (?, ?, 'participant')",
    );
    // David has many short days — many search hits; Maya has two long ones.
    const days: Array<[string, string, string, number]> = [
      ["maya-mon", "p-maya", "2026-10-19T08:00:00.000Z", 101],
      ["maya-tue", "p-maya", "2026-10-20T08:00:00.000Z", 94],
      ["david-mon", "p-david", "2026-10-19T09:00:00.000Z", 4],
      ["david-tue", "p-david", "2026-10-20T09:00:00.000Z", 3],
      ["david-wed", "p-david", "2026-10-21T09:00:00.000Z", 11],
    ];
    for (const [id, personId, at, count] of days) {
      const metadata = JSON.stringify({
        documentType: "conversation",
        extra: { messageCount: count },
      });
      insertDoc.run(id, id, id, `hash-${id}`, metadata, at, at, at, at);
      insertRole.run(id, "p-self");
      insertRole.run(id, personId);
    }
  }

  test("ranks the most-messaged person first even when another has more documents", async () => {
    seed();
    const tool = createCountMessagesTool({ port: createGatewayMessageCountPort(db) });
    const result = await tool.invoke(
      { from: "2026-10-19", to: "2026-10-26" },
      { sessionId: "S", messageId: "M", timeZone: "UTC" },
    );
    expect(result.kind).toBe("structured");
    const data = (result as { data: MessageCountPortResult }).data;
    expect(data.people.map((p) => [p.name, p.messages, p.documents])).toEqual([
      ["Maya", 195, 2],
      ["David", 18, 3],
    ]);
    expect(data.window).toEqual({
      from: "2026-10-19T00:00:00.000Z",
      toExclusive: "2026-10-26T00:00:00.000Z",
      timeZone: "UTC",
    });
  });

  test("runs the count through the read-worker gate when one is wired", async () => {
    seed();
    const seen: MessageCountsQuery[] = [];
    const port = createGatewayMessageCountPort(db, {
      gate: {
        async messageCounts(query) {
          seen.push(query);
          return countMessagesByPerson(db, query);
        },
      },
    });
    const result = await port.count({ from: "2026-10-19", timeZone: "UTC", limit: 5 });
    expect(seen).toEqual([
      {
        fromIso: "2026-10-19T00:00:00.000Z",
        toExclusiveIso: "2026-10-20T00:00:00.000Z",
        limit: 5,
      },
    ]);
    expect(result.people.map((p) => p.name)).toEqual(["Maya", "David"]);
  });
});
