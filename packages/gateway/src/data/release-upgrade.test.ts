// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import Database from "better-sqlite3";
import { ProviderId, SourceId } from "@omnesis/core";
import { createDatabase, upsertDocuments } from "../db.js";
import { prepareDocumentsForWrite } from "./repositories/DocumentRepository.js";
import { retractAliasAssertions } from "./repositories/PersonAliasRepository.js";
import { LATEST_SCHEMA_VERSION } from "./schema-version.js";

const fixture = new URL("./fixtures/release-171/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", fixture), "utf8"));
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function installedDatabase(): string {
  const compressed = readFileSync(new URL("gateway.db.gz", fixture));
  expect(createHash("sha256").update(compressed).digest("hex")).toBe(manifest.sha256);
  const dir = mkdtempSync(join(tmpdir(), "omnesis-release-upgrade-test-"));
  scratch.push(dir);
  const path = join(dir, "gateway.db");
  writeFileSync(path, gunzipSync(compressed));
  return path;
}

function preserved(db: Database.Database): void {
  expect(db.prepare("SELECT id, type, account_id FROM sources ORDER BY id").all()).toEqual(
    manifest.before.sources,
  );
  expect(
    db.prepare("SELECT id, source_id, external_id, content_hash FROM documents ORDER BY id").all(),
  ).toEqual(manifest.before.documents);
  expect(
    db
      .prepare("SELECT source_id, device_id, cursor FROM sync_state ORDER BY source_id, device_id")
      .all(),
  ).toEqual(manifest.before.cursors);
  expect(db.prepare("SELECT * FROM merge_rules ORDER BY id").all()).toEqual(manifest.before.rules);
  expect(db.prepare("SELECT * FROM person_equivalences ORDER BY from_id").all()).toEqual(
    manifest.before.equivalences,
  );
  expect(db.prepare("SELECT * FROM access_levels ORDER BY id").all()).toEqual(
    manifest.before.accessLevels,
  );
  expect(
    db.prepare("SELECT * FROM access_level_capabilities ORDER BY level_id, capability").all(),
  ).toEqual(manifest.before.accessCapabilities);
}

test("a release-produced schema 171 database upgrades without changing installed state", () => {
  const path = installedDatabase();
  const old = new Database(path, { readonly: true });
  expect(old.pragma("user_version", { simple: true })).toBe(171);
  expect(old.prepare("PRAGMA table_info(sources)").all()).not.toContainEqual(
    expect.objectContaining({ name: "account" }),
  );
  preserved(old);
  old.close();
  for (let open = 0; open < 2; open++) {
    const db = createDatabase(path);
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      preserved(db);
      expect(db.prepare("SELECT DISTINCT partition_key FROM documents").all()).toEqual([
        { partition_key: "" },
      ]);
      expect(db.prepare("SELECT alias FROM person_aliases WHERE id='fixture-lid'").get()).toEqual({
        alias: "whatsapp:7700900133",
      });
      expect(
        db
          .prepare(
            "SELECT source_id FROM person_alias_assertions WHERE alias_id='fixture-email' ORDER BY source_id",
          )
          .all(),
      ).toEqual([{ source_id: "apple-contacts:fixture" }, { source_id: "gmail:fixture" }]);
    } finally {
      db.close();
    }
  }
});

test("replayed installed documents retain identity and another source retains alias provenance", () => {
  const db = createDatabase(installedDatabase());
  try {
    const rows = db
      .prepare<
        [],
        {
          provider_id: string;
          source_id: string;
          external_id: string;
          title: string;
          content: string;
          content_hash: string;
          source_created_at: string;
          source_updated_at: string;
        }
      >("SELECT * FROM documents")
      .all();
    upsertDocuments(
      db,
      prepareDocumentsForWrite(
        rows.map((row) => ({
          providerId: ProviderId(row.provider_id),
          sourceId: SourceId(row.source_id),
          externalId: row.external_id,
          title: row.title,
          content: row.content,
          contentHash: row.content_hash,
          metadata: {},
          sourceCreatedAt: row.source_created_at,
          sourceUpdatedAt: row.source_updated_at,
        })),
      ),
    );
    preserved(db);
    retractAliasAssertions(db, "apple-contacts:fixture");
    expect(db.prepare("SELECT alias FROM person_aliases WHERE id='fixture-email'").get()).toEqual({
      alias: "maya@example.org",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM people").get()).toEqual({ count: 1 });
  } finally {
    db.close();
  }
});
