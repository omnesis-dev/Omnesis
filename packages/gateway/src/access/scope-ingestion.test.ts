// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProviderId,
  SourceId,
  AccountId,
  SourceType,
  type DocumentInput,
  type SourceScopes,
} from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../db.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createSourceWithId } from "../data/repositories/SourceRepository.js";
import { upsertSourceScopes } from "./scope-descriptors.js";
import { backfillDocumentScopes } from "./scope-backfill.js";
import { sourceScopeInclusionSql } from "./scope-sql.js";

const scopes: SourceScopes = {
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
function document(conversationId: string): DocumentInput {
  return {
    providerId: ProviderId("fictional"),
    sourceId: SourceId("fictional:one"),
    externalId: "parent",
    title: "Cedar planning",
    content: "Fictional conversation.",
    contentHash: "unchanged-content",
    metadata: { documentType: "conversation", extra: { conversationId } },
    sourceCreatedAt: "2026-01-01T00:00:00.000Z",
    sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("scope facts at the corpus ingestion boundary", () => {
  let db: ReturnType<typeof createDatabase>;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-scope-ingestion-"));
    db = createDatabase(join(dir, "test.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function visible() {
    const restriction = sourceScopeInclusionSql(
      [
        {
          sourceId: "fictional:one",
          audience: { accessLevel: "level", capability: "direct" },
          rules: [{ match: [{ kind: "conversation", id: "allowed" }], action: "share" }],
          otherwise: "hide",
        },
      ],
      "d.id",
      "d.source_id",
    );
    return (
      db
        .prepare(`SELECT 1 FROM documents d WHERE ${restriction.sql}`)
        .get(...restriction.params) !== undefined
    );
  }
  it("leaves existing unfiltered ingestion unchanged without a declaration", () => {
    upsertDocuments(db, [document("allowed")]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM documents").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT * FROM document_scope_facts").all()).toEqual([]);
  });
  it("projects metadata-only changes atomically despite an unchanged content hash", () => {
    upsertSourceScopes(db, [{ sourceType: "fictional", scopes }], 1);
    upsertDocuments(db, [document("allowed")]);
    expect(visible()).toBe(false);
    backfillDocumentScopes(db, 2);
    expect(visible()).toBe(true);
    const id = db.prepare("SELECT id FROM documents").get();
    upsertDocuments(db, [document("hidden")]);
    expect(db.prepare("SELECT id FROM documents").get()).toEqual(id);
    expect(visible()).toBe(false);
    expect(db.prepare("SELECT entity_id FROM document_scope_facts").all()).toEqual([
      { entity_id: "hidden" },
    ]);
  });
  it("uses the configured source type when its stable instance ID differs", () => {
    const device = createDevice(db, { name: "Fictional collector", kind: "collector" });
    const sourceId = SourceId("scope-instance");
    createSourceWithId(db, sourceId, {
      type: SourceType("fictional"),
      accountId: AccountId("one"),
      deviceId: device.id,
    });
    upsertSourceScopes(db, [{ sourceType: "fictional", scopes }], 1);
    upsertDocuments(db, [{ ...document("allowed"), sourceId }]);
    expect(db.prepare("SELECT entity_id FROM document_scope_facts").all()).toEqual([
      { entity_id: "allowed" },
    ]);
    upsertDocuments(db, [{ ...document("hidden"), sourceId }]);
    expect(db.prepare("SELECT entity_id FROM document_scope_facts").all()).toEqual([
      { entity_id: "hidden" },
    ]);
  });

  it("never replaces stored facts with an ignored older replica document", () => {
    upsertSourceScopes(db, [{ sourceType: "fictional", scopes }], 1);
    upsertDocuments(db, [document("allowed")]);
    backfillDocumentScopes(db, 2);
    const old = { ...document("hidden"), sourceUpdatedAt: "2025-01-01T00:00:00.000Z" };
    const result = upsertDocuments(db, [old], {
      replicaVersionPolicies: { "fictional:one": "source-updated-at" },
    });
    expect(result.ignoredReplicaDocuments).toHaveLength(1);
    expect(visible()).toBe(true);
  });
});
