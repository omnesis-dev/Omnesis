// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `createGatewayTrailPort` under graph context: the walk follows the links
 * search graph context follows unless a call names more, and a seed that is
 * part of a larger document defaults to a shallow walk. With graph context
 * off the walk is unchanged. All fixtures are invented.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AnalyticsDb } from "../analytics-db.js";
import { createDatabase } from "../db.js";
import { createGatewayTrailPort } from "./ports.js";
import type Database from "better-sqlite3";

const NOW = "2026-02-01T09:00:00.000Z";
let db: Database.Database;
let analytics: AnalyticsDb;
let sqlitePath: string;
let analyticsPath: string;

beforeEach(async () => {
  analyticsPath = `/tmp/omnesis-test-trail-gc-analytics-${randomUUID()}.db`;
  analytics = new AnalyticsDb(analyticsPath);
  await analytics.open();
  sqlitePath = `/tmp/omnesis-test-trail-gc-${randomUUID()}.db`;
  db = createDatabase(sqlitePath);
});

afterEach(async () => {
  db.close();
  await analytics.close();
  for (const path of [sqlitePath, analyticsPath])
    for (const suffix of ["", ".wal", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});

function doc(id: string, type: string, extra: Record<string, unknown> = {}): void {
  db.prepare(
    `INSERT INTO documents
    (id,provider_id,source_id,external_id,title,content,content_hash,metadata,
     source_created_at,source_updated_at,ingested_at,updated_at)
    VALUES (?,'fictional','mail:fictional',?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    id,
    `Title ${id}`,
    "A fictional body.",
    `h-${id}`,
    JSON.stringify({ documentType: type, extra }),
    NOW,
    NOW,
    NOW,
    NOW,
  );
}

function link(from: string, type: string, to: string): void {
  db.prepare(
    `INSERT INTO document_links
    (source_doc_id,link_type,raw_target,normalized_target,target_doc_id,created_at)
    VALUES (?,?,?,?,?,?)`,
  ).run(from, type, to, to, to, NOW);
}

/** Every document id anywhere in a trail, nested attachments included. */
function reached(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) reached(item, out);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (key === "documentId" && typeof item === "string") out.add(item);
      else reached(item, out);
    }
  return out;
}

// An attachment three structural hops from a note, plus a shared phone number.
function chain(): void {
  doc("email", "email");
  doc("attachment", "attachment", { parentExternalId: "email" });
  doc("earlier", "email");
  doc("note", "note");
  doc("far", "note");
  doc("same-number", "note");
  link("attachment", "contains", "email");
  link("email", "replies-to", "earlier");
  link("earlier", "references", "note");
  link("note", "references", "far");
  link("email", "shares-phone", "same-number");
}

describe("trail port under graph context", () => {
  test("a seed that is part of a larger document walks two links by default", async () => {
    chain();
    const ids = reached(
      await createGatewayTrailPort(db, analytics, { graphContext: true }).build(["attachment"]),
    );
    expect([...ids]).toEqual(expect.arrayContaining(["attachment", "email", "earlier"]));
    expect(ids.has("note")).toBe(false);
  });

  test("an explicit depth and a standalone seed keep the full default", async () => {
    chain();
    const port = createGatewayTrailPort(db, analytics, { graphContext: true });
    expect(reached(await port.build(["attachment"], { depth: 3 })).has("note")).toBe(true);
    expect(reached(await port.build(["email"])).has("far")).toBe(true);
  });

  test("follows only structural links unless the call names more", async () => {
    chain();
    const port = createGatewayTrailPort(db, analytics, { graphContext: true });
    expect(reached(await port.build(["email"])).has("same-number")).toBe(false);
    const widened = await port.build(["email"], { includeLinkTypes: ["shares-phone"] });
    expect(reached(widened).has("same-number")).toBe(true);
  });

  test("with graph context off the walk is unchanged", async () => {
    chain();
    const port = createGatewayTrailPort(db, analytics);
    expect(port.graphContext).toBe(false);
    const ids = reached(await port.build(["attachment"]));
    expect([...ids]).toEqual(expect.arrayContaining(["note", "same-number"]));
  });
});
