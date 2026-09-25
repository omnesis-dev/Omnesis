// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { findDocumentIdBySourceExternalId } from "./DocumentRepository.js";

let path: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  path = `/tmp/omnesis-document-source-lookup-${randomUUID()}.db`;
  db = createDatabase(path);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
});

function insert(id: string, sourceId: string, externalId: string, streamId = ""): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, stream_id, title, content,
                            content_hash, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', '', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(id, sourceId.split(":")[0], sourceId, externalId, streamId);
}

/**
 * The analytics catalog collapses a single-owner table's source id to the bare
 * type, so the row→document inverse arrives named either way. Naming the type
 * has to reach the account; naming an account must not reach a sibling.
 */
describe("findDocumentIdBySourceExternalId", () => {
  test("a bare type reaches the account that holds the external id", () => {
    insert("doc-1", "example-runs:52101", "activity-7");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "activity-7")).toBe("doc-1");
  });

  test("a named account does not reach a sibling account", () => {
    insert("doc-1", "example-runs:52101", "activity-7");
    expect(findDocumentIdBySourceExternalId(db, "example-runs:52102", "activity-7")).toBeNull();
  });

  test("a named account does not reach an account whose id extends it", () => {
    // `parseSourceId` splits on the first colon, so `52101:archive` is a whole
    // account id of its own — a different account, not a child of `52101`.
    insert("doc-1", "example-runs:52101:archive", "activity-7");
    expect(findDocumentIdBySourceExternalId(db, "example-runs:52101", "activity-7")).toBeNull();
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "activity-7")).toBe("doc-1");
  });

  test("a type is not a string prefix: it does not reach a differently named source", () => {
    insert("doc-1", "example-runs-archive:52101", "activity-7");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "activity-7")).toBeNull();
  });

  test("the exact account is preferred over another account of the same type", () => {
    insert("doc-1", "example-runs:52101", "activity-7");
    insert("doc-2", "example-runs", "activity-7");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "activity-7")).toBe("doc-2");
  });

  test("a named stream selects within it", () => {
    insert("doc-1", "example-runs:52101", "activity-7", "phone-a");
    insert("doc-2", "example-runs:52101", "activity-7", "phone-b");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "activity-7", "phone-b")).toBe(
      "doc-2",
    );
  });
});
