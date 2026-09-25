// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The bridge's pure half: snapshot reading (filters, ordering, the
 * max-docs refusal, read-only open) and the T0 split. All fixture data
 * is INVENTED (privacy rule) — a throwaway SQLite file with the real
 * `documents` schema, never a corpus snapshot.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { planReplay, readSnapshotDocuments, runBridge } from "./briefs-backtest-bridge.js";

let path: string;

function seedSnapshot(
  docs: Array<{ externalId: string; sourceId: string; at: string; title?: string }>,
): void {
  const db = new Database(path);
  db.exec(`CREATE TABLE documents (
    id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, source_id TEXT NOT NULL,
    external_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    content_hash TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
    source_created_at TEXT NOT NULL, source_updated_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  const insert = db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
       content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'p', ?, ?, ?, 'body', 'h', '{"documentType":"email"}', ?, ?, ?, ?)`,
  );
  for (const d of docs) {
    insert.run(
      randomUUID(),
      d.sourceId,
      d.externalId,
      d.title ?? d.externalId,
      d.at,
      d.at,
      d.at,
      d.at,
    );
  }
  db.close();
}

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
});
afterEach(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
});

describe("readSnapshotDocuments", () => {
  test("orders by source_created_at, honours the window end and source filter", () => {
    seedSnapshot([
      { externalId: "b", sourceId: "imap:sam@example.com", at: "2026-05-02T00:00:00.000Z" },
      { externalId: "a", sourceId: "imap:sam@example.com", at: "2026-05-01T00:00:00.000Z" },
      { externalId: "later", sourceId: "imap:sam@example.com", at: "2026-06-01T00:00:00.000Z" },
      { externalId: "other", sourceId: "chat:sam@example.com", at: "2026-05-01T12:00:00.000Z" },
    ]);
    const all = readSnapshotDocuments(path, { untilMs: Date.parse("2026-05-31T00:00:00Z") });
    expect(all.map((d) => d.externalId)).toEqual(["a", "other", "b"]);
    const filtered = readSnapshotDocuments(path, {
      untilMs: Date.parse("2026-05-31T00:00:00Z"),
      sources: ["imap:sam@example.com"],
    });
    expect(filtered.map((d) => d.externalId)).toEqual(["a", "b"]);
    expect(filtered[0]!.metadata).toEqual({ documentType: "email" });
  });

  test("refuses a replay over the max-docs cap", () => {
    seedSnapshot([
      { externalId: "a", sourceId: "s:x", at: "2026-05-01T00:00:00.000Z" },
      { externalId: "b", sourceId: "s:x", at: "2026-05-02T00:00:00.000Z" },
    ]);
    expect(() =>
      readSnapshotDocuments(path, { untilMs: Date.parse("2026-06-01T00:00:00Z"), maxDocs: 1 }),
    ).toThrow(/max-docs/);
  });
});

describe("planReplay", () => {
  test("splits at T0 inclusive", () => {
    seedSnapshot([
      { externalId: "old", sourceId: "s:x", at: "2026-05-01T00:00:00.000Z" },
      { externalId: "att0", sourceId: "s:x", at: "2026-05-10T00:00:00.000Z" },
      { externalId: "new", sourceId: "s:x", at: "2026-05-10T00:00:00.001Z" },
    ]);
    const docs = readSnapshotDocuments(path, { untilMs: Date.parse("2026-06-01T00:00:00Z") });
    const plan = planReplay(docs, Date.parse("2026-05-10T00:00:00.000Z"));
    expect(plan.backfill.map((d) => d.externalId)).toEqual(["old", "att0"]);
    expect(plan.window.map((d) => d.externalId)).toEqual(["new"]);
  });
});

describe("runBridge safety rails", () => {
  test("refuses the default live port before touching anything", async () => {
    await expect(
      runBridge({
        snapshotPath: path,
        gatewayUrl: "https://localhost:7600",
        token: "t",
        t0Ms: 0,
        untilMs: 1,
      }),
    ).rejects.toThrow(/live port/);
  });

  test("dry-run plans without a gateway", async () => {
    seedSnapshot([{ externalId: "a", sourceId: "s:x", at: "2026-05-01T00:00:00.000Z" }]);
    const report = await runBridge({
      snapshotPath: path,
      gatewayUrl: "http://localhost:17999",
      token: "t",
      t0Ms: Date.parse("2026-05-02T00:00:00Z"),
      untilMs: Date.parse("2026-05-03T00:00:00Z"),
      dryRun: true,
      log: () => {},
    });
    expect(report).toEqual({ backfilled: 0, dripped: 0, finalVirtualNowMs: expect.any(Number) });
  });
});
