// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProviderId,
  SourceId,
  type DocumentInput,
  type ScopePolicy,
  type SourceScopes,
} from "@omnesis/types";
import { runSchemaSetup } from "../data/schema.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { upsertWithCursor } from "../data/repositories/DocumentRepository.js";
import { getSyncState } from "../data/repositories/SyncStateRepository.js";
import { upsertSourceScopes } from "./scope-descriptors.js";
import { sourceScopeInclusionSql } from "./scope-sql.js";
import { sourceScopeUpdatesSchema } from "./scope-update-schema.js";
import { projectStoredDocumentScopes } from "./scope-projection.js";

const sourceId = SourceId("fictional-mail:one");
const providerId = ProviderId("fictional:one");
const scopes: SourceScopes = {
  items: [
    { kind: "label", noun: { one: "label", many: "labels" }, picker: "search", link: "changes" },
    { kind: "participant", identifiers: ["email", "domain"], link: "fixed" },
  ],
  legacyProjection: { participants: { roles: ["sender", "recipient"], membership: "document" } },
};
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  runSchemaSetup(db);
  const device = createDevice(db, { name: "Fictional collector", kind: "collector" });
  db.prepare(
    "INSERT INTO sources(id,type,account_id,device_id,created_at,updated_at) VALUES(?, 'fictional-mail','one',?,1,1)",
  ).run(sourceId, device.id);
  upsertSourceScopes(db, [{ sourceType: "fictional-mail", scopes }], 1);
  db.prepare(
    "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES(?,'fictional-mail',?,1)",
  ).run(sourceId, JSON.stringify(scopes));
});
afterEach(() => db.close());
function mail(externalId = "message"): DocumentInput {
  return {
    providerId,
    sourceId,
    externalId,
    title: "Invented telescope schedule",
    content: "Fictional observation timetable",
    contentHash: "invented-content-hash",
    sourceCreatedAt: "2026-01-01T00:00:00.000Z",
    sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    metadata: {
      documentType: "email",
      people: [{ role: "sender", emails: ["observer@example.org"] }],
      scopeFacts: {
        kinds: ["label"],
        facts: [{ kind: "label", id: "label-old" }],
        complete: ["label"],
      },
    },
  };
}
function visible(label: string): string[] {
  const policy: ScopePolicy = {
    sourceId,
    audience: { accessLevel: "test", capability: "direct" },
    rules: [{ match: [{ kind: "label", id: label }], action: "share" }],
    otherwise: "hide",
  };
  const filter = sourceScopeInclusionSql([policy], "d.id", "d.source_id");
  return db
    .prepare<unknown[], { external_id: string }>(
      `SELECT d.external_id FROM documents d WHERE ${filter.sql} ORDER BY d.external_id`,
    )
    .all(...filter.params)
    .map((row) => row.external_id);
}
describe("atomic source scope metadata pages", () => {
  it("changes label visibility on the next read while retaining body and participant facts", () => {
    upsertWithCursor(db, {
      providerId,
      sourceId,
      documents: [mail()],
      hasMore: false,
      cursor: { page: 1 },
    });
    expect(visible("label-old")).toEqual(["message"]);
    upsertWithCursor(db, {
      providerId,
      sourceId,
      hasMore: false,
      cursor: { page: 2 },
      scopeUpdates: {
        documents: [
          {
            externalId: "message",
            kinds: ["label"],
            facts: {
              kinds: ["label"],
              facts: [{ kind: "label", id: "label-new" }],
              complete: ["label"],
            },
            tags: ["Cedar renamed"],
            relevanceScore: 0.8,
          },
        ],
      },
    });
    expect(visible("label-old")).toEqual([]);
    expect(visible("label-new")).toEqual(["message"]);
    const row = db
      .prepare<[], { id: string; content: string; metadata: string }>(
        "SELECT id,content,metadata FROM documents",
      )
      .get()!;
    expect(row.content).toBe("Fictional observation timetable");
    expect(JSON.parse(row.metadata)).toMatchObject({
      tags: ["Cedar renamed"],
      relevanceScore: 0.8,
    });
    expect(
      db
        .prepare(
          "SELECT 1 FROM document_scope_facts WHERE document_id=? AND entity_id='email:observer@example.org'",
        )
        .get(row.id),
    ).toBeDefined();
    expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toMatchObject({ page: 2 });
  });
  it("rolls back documents, readiness, and cursor together when a scope update is invalid", () => {
    upsertWithCursor(db, { providerId, sourceId, hasMore: false, cursor: { page: 1 } });
    expect(() =>
      upsertWithCursor(db, {
        providerId,
        sourceId,
        documents: [mail()],
        hasMore: false,
        cursor: { page: 2 },
        scopeUpdates: { readiness: [{ kind: "folder", complete: true }] },
      }),
    ).toThrow(/kind/);
    expect(db.prepare("SELECT count(*) AS count FROM documents").get()).toEqual({ count: 0 });
    expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toMatchObject({ page: 1 });
    expect(db.prepare("SELECT * FROM source_scope_kind_readiness").all()).toEqual([]);
  });
  it("matches by stable ID across rename and distinguishes recreated labels", () => {
    upsertWithCursor(db, {
      providerId,
      sourceId,
      documents: [mail()],
      hasMore: false,
      cursor: {},
      scopeUpdates: { entities: [{ kind: "label", id: "label-old", label: "Cedar" }] },
    });
    upsertWithCursor(db, {
      providerId,
      sourceId,
      hasMore: false,
      cursor: {},
      scopeUpdates: { entities: [{ kind: "label", id: "label-old", label: "Cedar renamed" }] },
    });
    expect(visible("label-old")).toEqual(["message"]);
    upsertWithCursor(db, {
      providerId,
      sourceId,
      hasMore: false,
      cursor: {},
      scopeUpdates: {
        replaceEntityKinds: ["label"],
        entities: [{ kind: "label", id: "label-new", label: "Cedar renamed" }],
        documents: [
          {
            externalId: "message",
            kinds: ["label"],
            facts: { facts: [{ kind: "label", id: "label-new" }], complete: ["label"] },
          },
        ],
      },
    });
    expect(visible("label-old")).toEqual([]);
    expect(visible("label-new")).toEqual(["message"]);
  });
  it("never updates a sibling provider or stream through an external ID", () => {
    upsertWithCursor(db, { providerId, sourceId, documents: [mail()], hasMore: false, cursor: {} });
    for (const context of [
      { providerId: "fictional:other", streamId: "" },
      { providerId, streamId: "other-stream" },
    ]) {
      upsertWithCursor(db, {
        ...context,
        sourceId,
        hasMore: false,
        cursor: {},
        scopeUpdates: {
          documents: [
            { externalId: "message", kinds: ["label"], facts: { facts: [], complete: ["label"] } },
          ],
        },
      });
    }
    expect(visible("label-old")).toEqual(["message"]);
  });
  it("retains an explicit unknown participant override during a label-only patch", () => {
    const doc = mail();
    doc.metadata.scopeFacts = {
      kinds: ["participant", "label"],
      facts: [{ kind: "label", id: "label-old" }],
      complete: ["label"],
    };
    upsertWithCursor(db, { providerId, sourceId, documents: [doc], hasMore: false, cursor: {} });
    upsertWithCursor(db, {
      providerId,
      sourceId,
      hasMore: false,
      cursor: {},
      scopeUpdates: {
        documents: [
          { externalId: "message", kinds: ["label"], facts: { facts: [], complete: ["label"] } },
        ],
      },
    });
    expect(
      db.prepare("SELECT * FROM document_scope_completeness WHERE kind='participant'").all(),
    ).toEqual([]);
  });

  it("denies stale complete label facts throughout an interrupted explicit refresh", () => {
    upsertWithCursor(db, {
      providerId,
      sourceId,
      documents: [mail()],
      hasMore: false,
      cursor: { page: 1 },
    });
    expect(visible("label-old")).toEqual(["message"]);
    upsertWithCursor(db, {
      providerId,
      sourceId,
      hasMore: true,
      cursor: { page: 2 },
      scopeUpdates: {
        readiness: [{ kind: "label", complete: false }],
        refreshes: [{ kind: "label", active: true }],
      },
    });
    expect(visible("label-old")).toEqual([]);
    const epoch = db
      .prepare<[string], { epoch: string }>(
        "SELECT epoch FROM source_scope_refresh_requirements WHERE source_id=? AND kind='label'",
      )
      .get(sourceId)!.epoch;
    const personPolicy: ScopePolicy = {
      sourceId,
      audience: { accessLevel: "test", capability: "direct" },
      rules: [
        {
          match: [
            {
              kind: "participant",
              label: "Observer",
              identifiers: [{ type: "email", value: "observer@example.org" }],
            },
          ],
          action: "share",
        },
      ],
      otherwise: "hide",
    };
    const personFilter = sourceScopeInclusionSql([personPolicy], "d.id", "d.source_id");
    expect(
      db
        .prepare(`SELECT d.external_id FROM documents d WHERE ${personFilter.sql}`)
        .all(...personFilter.params),
    ).toEqual([{ external_id: "message" }]);
    // An unrelated ordinary page cannot clear the refresh fence.
    upsertWithCursor(db, { providerId, sourceId, hasMore: false, cursor: { page: 3 } });
    expect(visible("label-old")).toEqual([]);
    upsertWithCursor(db, {
      providerId,
      sourceId,
      hasMore: false,
      cursor: { page: 4 },
      scopeUpdates: {
        documents: [
          { externalId: "message", kinds: ["label"], facts: { facts: [], complete: ["label"] } },
        ],
        readiness: [{ kind: "label", complete: true }],
        refreshes: [{ kind: "label", active: false }],
      },
    });
    expect(visible("label-old")).toEqual([]);
    expect(
      db
        .prepare("SELECT active FROM source_scope_refreshes WHERE source_id=? AND kind='label'")
        .get(sourceId),
    ).toEqual({ active: 1 });
    // A legacy completion cannot acknowledge the new cut. A refreshed publisher
    // must echo it both on completion and on the document's explicit facts.
    upsertWithCursor(db, {
      providerId,
      sourceId,
      hasMore: false,
      cursor: { page: 5 },
      scopeUpdates: {
        documents: [
          {
            externalId: "message",
            kinds: ["label"],
            facts: {
              facts: [{ kind: "label", id: "label-new" }],
              complete: ["label"],
              refreshEpochs: { label: epoch },
            },
          },
        ],
        readiness: [{ kind: "label", complete: true }],
        refreshes: [{ kind: "label", active: false, epoch }],
      },
    });
    expect(visible("label-old")).toEqual([]);
    expect(visible("label-new")).toEqual(["message"]);
    expect(
      db
        .prepare("SELECT active FROM source_scope_refreshes WHERE source_id=? AND kind='label'")
        .get(sourceId),
    ).toEqual({ active: 0 });
  });

  it("editor readiness changes alone leave known document facts usable", () => {
    upsertWithCursor(db, { providerId, sourceId, documents: [mail()], hasMore: false, cursor: {} });
    upsertWithCursor(db, {
      providerId,
      sourceId,
      hasMore: false,
      cursor: {},
      scopeUpdates: { readiness: [{ kind: "label", complete: false }] },
    });
    expect(visible("label-old")).toEqual(["message"]);
  });

  it("an old collector's missing label facts revoke editor readiness without hiding known siblings", () => {
    upsertWithCursor(db, {
      providerId,
      sourceId,
      documents: [mail()],
      hasMore: false,
      cursor: {},
      scopeUpdates: { readiness: [{ kind: "label", complete: true }] },
    });
    const legacy = mail("legacy-message");
    delete legacy.metadata.scopeFacts;
    upsertWithCursor(db, { providerId, sourceId, documents: [legacy], hasMore: false, cursor: {} });
    expect(visible("label-old")).toEqual(["message"]);
    expect(
      db
        .prepare("SELECT ready FROM source_scope_kind_readiness WHERE source_id=? AND kind='label'")
        .get(sourceId),
    ).toEqual({ ready: 0 });
  });

  it("an explicitly unknown native label assertion does not revoke source readiness", () => {
    upsertWithCursor(db, {
      providerId,
      sourceId,
      documents: [mail()],
      hasMore: false,
      cursor: {},
      scopeUpdates: { readiness: [{ kind: "label", complete: true }] },
    });
    const unknown = mail("native-unknown");
    unknown.metadata.scopeFacts = { kinds: ["label"], facts: [], complete: [] };
    upsertWithCursor(db, {
      providerId,
      sourceId,
      documents: [unknown],
      hasMore: false,
      cursor: {},
    });
    expect(
      db
        .prepare("SELECT ready FROM source_scope_kind_readiness WHERE source_id=? AND kind='label'")
        .get(sourceId),
    ).toEqual({ ready: 1 });
    expect(visible("label-old")).toEqual(["message"]);
  });

  it("historical documents without label metadata do not undo a newer native completion", () => {
    const legacy = mail("historical-legacy");
    delete legacy.metadata.scopeFacts;
    upsertWithCursor(db, {
      providerId,
      sourceId,
      documents: [mail(), legacy],
      hasMore: false,
      cursor: {},
      scopeUpdates: { readiness: [{ kind: "label", complete: true }] },
    });
    const row = db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id=?")
      .get(legacy.externalId)!;
    projectStoredDocumentScopes(
      db,
      {
        id: row.id,
        providerId,
        sourceId,
        streamId: "",
        externalId: legacy.externalId,
        metadata: legacy.metadata,
        historical: true,
      },
      scopes,
    );
    expect(
      db
        .prepare("SELECT ready FROM source_scope_kind_readiness WHERE source_id=? AND kind='label'")
        .get(sourceId),
    ).toEqual({ ready: 1 });
    expect(visible("label-old")).toEqual(["message"]);
  });

  it("attachment label decisions inherit the parent without revoking native-kind readiness", () => {
    upsertWithCursor(db, {
      providerId,
      sourceId,
      documents: [mail()],
      hasMore: false,
      cursor: {},
      scopeUpdates: { readiness: [{ kind: "label", complete: true }] },
    });
    const attachment = mail("message/att/synthetic");
    attachment.metadata = { documentType: "attachment", extra: { parentExternalId: "message" } };
    upsertWithCursor(db, {
      providerId,
      sourceId,
      documents: [attachment],
      hasMore: false,
      cursor: {},
    });
    expect(visible("label-old")).toEqual(["message", "message/att/synthetic"]);
    expect(
      db
        .prepare("SELECT ready FROM source_scope_kind_readiness WHERE source_id=? AND kind='label'")
        .get(sourceId),
    ).toEqual({ ready: 1 });
  });

  it("rejects facts outside explicitly replaced kinds", () => {
    expect(
      sourceScopeUpdatesSchema.safeParse({
        documents: [
          {
            externalId: "message",
            kinds: ["label"],
            facts: { facts: [{ kind: "folder", id: "outside" }], complete: ["folder"] },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
