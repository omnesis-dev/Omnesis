// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A corpus database and an index-copy database holding an invented account,
 * for the tests of the filter check. Nothing here is used outside tests, and
 * every name, address and number is made up.
 */

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { runMigrations } from "../data/migrations.js";
import { runSchemaSetup } from "../data/schema.js";
import { upsertSourceDocumentProfiles } from "../data/repositories/SourceDocumentProfileRepository.js";
import {
  stageFilterListPart,
  type FilterListStagedRow,
} from "../data/repositories/SourceFilterListRepository.js";
import {
  buildFilterCopyBatch,
  createFilterCopyTables,
  refreshFilterListCopy,
  writeFilterCopyBatch,
} from "../indexer/filter-copy.js";
import { registerFilterSqlFunctions } from "./filter-people.js";
import type { Db } from "../data/types.js";
import type { DocumentEventProfile } from "@omnesis/source-sdk";
import type { FilterListItem, SourceFilter, FilterRef } from "@omnesis/types";

export interface FilterFixture {
  db: Db;
  indexDb: Db;
  close(): void;
}

/**
 * `unreadableMetadata` removes the indexes and triggers of `documents` that
 * read its metadata as JSON. With them in place the store refuses a document
 * whose metadata is not JSON; without them the tests can hold one, to prove
 * the check does not depend on that refusal.
 */
export function openFilterFixture(options: { unreadableMetadata?: boolean } = {}): FilterFixture {
  const db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  runSchemaSetup(db);
  runMigrations(db);
  if (options.unreadableMetadata) {
    const readers = db
      .prepare<[], { type: string; name: string }>(
        `SELECT type, name FROM sqlite_master
          WHERE tbl_name = 'documents' AND type IN ('index', 'trigger') AND sql LIKE '%json%'`,
      )
      .all();
    for (const reader of readers) db.exec(`DROP ${reader.type} "${reader.name}"`);
  }
  registerFilterSqlFunctions(db);
  const indexDb = new Database(":memory:") as unknown as Db;
  createFilterCopyTables(indexDb);
  registerFilterSqlFunctions(indexDb);
  return {
    db,
    indexDb,
    close() {
      db.close();
      indexDb.close();
    },
  };
}

export const LABEL_NOUN = { one: "label", many: "labels" };
export const FOLDER_NOUN = { one: "folder", many: "folders" };
export const PROJECT_NOUN = { one: "project folder", many: "project folders" };
export const CHAT_NOUN = { one: "chat", many: "chats" };

/**
 * A mail-like source type: labels from version 2, folders (a tree) from
 * version 3, a per-device project folder, per-device tags, and people on the
 * record itself with a cap of five.
 */
export const LEDGER_PROFILE = {
  documentTypes: ["entry", "attachment"],
  personRoles: ["sender", "recipient", "mentioned"],
  metadataFields: [
    {
      path: "extra.labelIds",
      type: "string-array",
      description: "Label ids.",
      filter: {
        capability: "membership",
        minVersion: 2,
        scope: "global",
        noun: LABEL_NOUN,
        picker: "search",
      },
    },
    {
      path: "extra.folderIds",
      type: "string-array",
      description: "Folder ids.",
      filter: {
        capability: "tree",
        minVersion: 3,
        scope: "global",
        noun: FOLDER_NOUN,
        levels: [FOLDER_NOUN],
        picker: "tree",
        inside: FOLDER_NOUN,
      },
    },
    {
      path: "extra.directory",
      type: "string",
      description: "Directory on the device.",
      filter: {
        capability: "tree",
        minVersion: 0,
        scope: "device",
        noun: PROJECT_NOUN,
        levels: [PROJECT_NOUN],
        picker: "tree",
        inside: PROJECT_NOUN,
      },
    },
    {
      path: "extra.tagIds",
      type: "string-array",
      description: "Tags on the device.",
      filter: {
        capability: "membership",
        minVersion: 0,
        scope: "device",
        noun: { one: "tag", many: "tags" },
        picker: "search",
      },
    },
  ],
  personFilter: {
    minVersion: 0,
    roles: ["sender", "recipient"],
    identifiers: ["email", "phone", "domain"],
    maxPeople: 5,
  },
} as unknown as DocumentEventProfile;

/** A chat-like source type: a chat id on every record, and people who also come from the chat's members. */
export const PARLEY_PROFILE = {
  documentTypes: ["day"],
  personRoles: ["participant", "mentioned"],
  metadataFields: [
    {
      path: "extra.chatId",
      type: "string",
      description: "Chat id.",
      filter: {
        capability: "membership",
        minVersion: 0,
        scope: "global",
        noun: CHAT_NOUN,
        picker: "search",
        listsMembers: true,
      },
    },
  ],
  personFilter: {
    minVersion: 0,
    roles: ["participant"],
    identifiers: ["phone"],
    membersOf: "extra.chatId",
  },
} as unknown as DocumentEventProfile;

export function publishProfile(
  db: Db,
  sourceType: string,
  outputRevision: number,
  profile: DocumentEventProfile,
): void {
  upsertSourceDocumentProfiles(db, [{ sourceType, outputRevision, profile }], Date.now());
}

/** Publish a list as its current version, whole. */
export function publishList(
  db: Db,
  key: { sourceId: string; field: string; deviceId?: string },
  items: readonly FilterListItem[],
): void {
  const rows: FilterListStagedRow[] = [];
  for (const item of items) {
    rows.push([
      "item",
      item.id,
      item.parentId ?? null,
      item.label,
      item.membersIncomplete === true,
    ]);
    for (const member of item.members ?? []) {
      rows.push(["member", item.id, member.type, member.value]);
    }
  }
  const result = stageFilterListPart(db, {
    key: { sourceId: key.sourceId, field: key.field, deviceId: key.deviceId ?? "" },
    digest: randomUUID().replace(/-/g, "").padEnd(64, "0"),
    part: 0,
    final: true,
    rows,
    now: Date.now(),
  });
  if (result.kind !== "done" || result.outcome !== "published") {
    throw new Error(`The fixture list was not published: ${JSON.stringify(result)}`);
  }
}

export interface FixtureDocument {
  id: string;
  sourceId: string;
  externalId?: string;
  streamId?: string;
  version?: number;
  /** An object is stored as JSON; a string is stored as it is, valid or not. */
  metadata: unknown;
  title?: string;
  updatedAt?: string;
}

export function insertDocument(db: Db, document: FixtureDocument): void {
  const at = document.updatedAt ?? "2027-03-01T09:00:00.000Z";
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, stream_id, title, content,
       content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at, source_version)
     VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?)`,
  ).run(
    document.id,
    document.sourceId,
    document.sourceId,
    document.externalId ?? document.id,
    document.streamId ?? "",
    document.title ?? document.id,
    typeof document.metadata === "string" ? document.metadata : JSON.stringify(document.metadata),
    at,
    at,
    at,
    at,
    document.version ?? 0,
  );
}

/** Bring the index copy in line with the corpus: every list and every document. */
export function syncFilterCopy(fixture: FilterFixture): void {
  refreshFilterListCopy({ corpusDb: fixture.db, indexDb: fixture.indexDb });
  const ids = fixture.db
    .prepare<[], { id: string }>("SELECT id FROM documents")
    .all()
    .map((row) => row.id);
  writeFilterCopyBatch(fixture.indexDb, buildFilterCopyBatch(fixture.db, ids));
}

export function shareOnly(sourceId: string, match: FilterRef[]): SourceFilter {
  return {
    sourceId,
    audience: { accessLevel: "level-1", capability: "direct" },
    rules: [{ match, action: "share" }],
    otherwise: "hide",
  };
}

export function hide(sourceId: string, match: FilterRef[]): SourceFilter {
  return {
    sourceId,
    audience: { accessLevel: "level-1", capability: "direct" },
    rules: [{ match, action: "hide" }],
    otherwise: "share",
  };
}

export const label = (id: string): FilterRef => ({
  capability: "membership",
  field: "extra.labelIds",
  id,
});
export const folder = (id: string): FilterRef => ({
  capability: "tree",
  field: "extra.folderIds",
  id,
});
export const directory = (device: string, id: string): FilterRef => ({
  capability: "tree",
  field: "extra.directory",
  id,
  device,
});
export const tag = (device: string, id: string): FilterRef => ({
  capability: "membership",
  field: "extra.tagIds",
  id,
  device,
});
export const chat = (id: string): FilterRef => ({
  capability: "membership",
  field: "extra.chatId",
  id,
});
export const person = (
  name: string,
  ...identifiers: Array<[type: "email" | "phone" | "domain", value: string]>
): FilterRef => ({
  capability: "person",
  label: name,
  identifiers: identifiers.map(([type, value]) => ({ type, value })),
});
