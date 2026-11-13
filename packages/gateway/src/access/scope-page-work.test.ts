// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SqliteDatabase from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderId,
  SourceId,
  type DocumentInput,
  type ScopePolicy,
  type SourceScopes,
} from "@omnesis/types";
import { runSchemaSetup } from "../data/schema.js";
import { directWriteGate } from "../write-gate.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import {
  upsertWithCursor,
  upsertDocuments,
  upsertWithCursorYieldable,
  type UpsertWithCursorArgs,
} from "../data/repositories/DocumentRepository.js";
import { getSyncState, bumpWipeEpoch } from "../data/repositories/SyncStateRepository.js";
import { upsertSourceScopes } from "./scope-descriptors.js";
import { sourceScopeInclusionSql } from "./scope-sql.js";

// Facts are kept only while source filters are in use, which these tests take
// as given: experimental mode is on unless a test switches it off.
beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const sourceId = SourceId("fictional-mail:one");
const providerId = ProviderId("fictional:one");
const scopes: SourceScopes = {
  items: [
    { kind: "label", noun: { one: "label", many: "labels" }, picker: "search", link: "changes" },
    { kind: "participant", identifiers: ["email", "domain"], link: "fixed" },
  ],
  legacyProjection: { participants: { roles: ["sender", "recipient"], membership: "document" } },
};
let db: SqliteDatabase.Database;
beforeEach(() => {
  db = new SqliteDatabase(":memory:");
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
describe("yieldable metadata-only pages", () => {
  function metadataPage(): UpsertWithCursorArgs {
    upsertWithCursor(db, {
      sourceId,
      providerId,
      documents: [mail("one"), mail("two"), mail("three")],
      hasMore: false,
      cursor: { page: "before" },
    });
    db.prepare("INSERT INTO source_scope_refreshes(source_id,kind,active) VALUES(?,'label',1)").run(
      sourceId,
    );
    return {
      sourceId,
      providerId,
      hasMore: false,
      cursor: { page: "after" },
      scopeUpdates: {
        documents: ["one", "two", "three"].map((externalId) => ({
          externalId,
          kinds: ["label"],
          facts: { kinds: ["label"], facts: [{ kind: "label", id: "new" }], complete: ["label"] },
        })),
        refreshes: [{ kind: "label", active: false }],
        readiness: [{ kind: "label", complete: true }],
        replaceEntityKinds: ["label"],
        entities: [{ kind: "label", id: "catalogue", label: "Fictional catalogue label" }],
      },
    };
  }
  function changed(): string[] {
    return db
      .prepare<[], { external_id: string }>(
        `SELECT d.external_id FROM documents d JOIN document_scope_facts f ON f.document_id=d.id
       WHERE f.kind='label' AND f.entity_id='new' ORDER BY d.external_id`,
      )
      .all()
      .map((row) => row.external_id);
  }
  it("commits metadata prefixes without advancing cursor or publishing final controls", () => {
    const page = metadataPage();
    const first = upsertWithCursorYieldable(db, page, { token: { requested: () => true } });
    expect(first.kind).toBe("yield");
    expect(changed()).toEqual(["one"]);
    expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toEqual({ page: "before" });
    expect(
      db.prepare("SELECT 1 FROM scope_entities WHERE entity_id='catalogue'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT active FROM source_scope_refreshes WHERE source_id=?").get(sourceId),
    ).toEqual({ active: 1 });
    expect(
      db
        .prepare("SELECT ready FROM source_scope_kind_readiness WHERE source_id=? AND kind='label'")
        .get(sourceId),
    ).not.toEqual({ ready: 1 });
    if (first.kind !== "yield") throw new Error("Expected yield");
    const last = upsertWithCursorYieldable(db, first.resume, { token: { requested: () => false } });
    expect(last.kind).toBe("done");
    expect(changed()).toEqual(["one", "three", "two"]);
    expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toEqual({ page: "after" });
    expect(
      db
        .prepare("SELECT ready FROM source_scope_kind_readiness WHERE source_id=? AND kind='label'")
        .get(sourceId),
    ).toEqual({ ready: 1 });
    expect(db.prepare("SELECT entity_id FROM scope_entities WHERE kind='label'").all()).toEqual([
      { entity_id: "catalogue" },
    ]);
  });
  /** A page of label facts for `count` stored messages. */
  function manyLabels(count: number): { page: UpsertWithCursorArgs; ids: string[] } {
    const ids = Array.from({ length: count }, (_, index) => `m${String(index).padStart(3, "0")}`);
    upsertWithCursor(db, {
      sourceId,
      providerId,
      documents: ids.map((id) => mail(id)),
      hasMore: false,
      cursor: { page: "before" },
    });
    return {
      ids,
      page: {
        sourceId,
        providerId,
        hasMore: false,
        cursor: { page: "after" },
        scopeUpdates: {
          documents: ids.map((externalId) => ({
            externalId,
            kinds: ["label"],
            facts: { kinds: ["label"], facts: [{ kind: "label", id: "new" }], complete: ["label"] },
          })),
        },
      },
    };
  }
  /** Counts the physical transactions begun on `db` from here on. */
  function countCommits(): () => number {
    const begin = db.transaction.bind(db);
    let commits = 0;
    vi.spyOn(db, "transaction").mockImplementation(((work: (...args: unknown[]) => unknown) => {
      const run = begin(work);
      return (...args: unknown[]) => {
        if (!db.inTransaction) commits++;
        return run(...args);
      };
    }) as never);
    return () => commits;
  }
  it("commits a page's items in short runs when no write is waiting", () => {
    const { page, ids } = manyLabels(40);
    const commits = countCommits();
    const outcome = upsertWithCursorYieldable(db, page, { token: { requested: () => false } });
    expect(outcome.kind).toBe("done");
    expect(changed()).toEqual(ids);
    // Forty items in runs of sixteen, and the page's own bookkeeping: far
    // fewer commits than items.
    expect(commits()).toBeGreaterThanOrEqual(3);
    expect(commits()).toBeLessThan(15);
  });
  it("ends a run after the item in hand when a write starts waiting", () => {
    const { page, ids } = manyLabels(40);
    let checks = 0;
    const first = upsertWithCursorYieldable(db, page, {
      token: { requested: () => ++checks >= 5 },
    });
    expect(first.kind).toBe("yield");
    expect(changed()).toEqual(ids.slice(0, 5));
    expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toEqual({ page: "before" });
    if (first.kind !== "yield") throw new Error("Expected yield");
    const last = upsertWithCursorYieldable(db, first.resume, { token: { requested: () => false } });
    expect(last.kind).toBe("done");
    expect(changed()).toEqual(ids);
    expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toEqual({ page: "after" });
  });
  it("revokes refresh authority before publishing the first partial metadata prefix", () => {
    const page = metadataPage();
    db.prepare("UPDATE source_scope_refreshes SET active=0 WHERE source_id=?").run(sourceId);
    page.scopeUpdates!.refreshes = [{ kind: "label", active: true }];
    page.scopeUpdates!.readiness = [{ kind: "label", complete: false }];
    const first = upsertWithCursorYieldable(db, page, { token: { requested: () => true } });
    expect(first.kind).toBe("yield");
    expect(changed()).toEqual(["one"]);
    expect(visible("label-old")).toEqual([]);
    expect(
      db.prepare("SELECT active FROM source_scope_refreshes WHERE source_id=?").get(sourceId),
    ).toEqual({ active: 1 });
    expect(
      db
        .prepare("SELECT ready FROM source_scope_kind_readiness WHERE source_id=? AND kind='label'")
        .get(sourceId),
    ).toEqual({ ready: 0 });
  });
  it("the direct server fallback yields between prefixes and still waits for final controls", async () => {
    const page = metadataPage();
    const promise = directWriteGate(db).upsertWithCursor(page);
    expect(changed()).toEqual(["one"]);
    expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toEqual({ page: "before" });
    const outcome = await promise;
    expect(outcome.rejected).not.toBe(true);
    expect(changed()).toEqual(["one", "three", "two"]);
    expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toEqual({ page: "after" });
  });
  it("rejects a revoked write epoch before any remaining metadata writes", () => {
    const first = upsertWithCursorYieldable(db, metadataPage(), {
      token: { requested: () => true },
    });
    if (first.kind !== "yield") throw new Error("Expected yield");
    bumpWipeEpoch(db, sourceId);
    const outcome = upsertWithCursorYieldable(db, first.resume, {
      token: { requested: () => false },
    });
    expect(outcome).toMatchObject({ kind: "done", value: { rejected: true } });
    expect(changed()).toEqual(["one"]);
    expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toEqual({ page: "before" });
  });
  it("rejects removed membership before a writer continuation", () => {
    const page = metadataPage();
    const actor = db
      .prepare<[string], { device_id: string }>("SELECT device_id FROM sources WHERE id=?")
      .get(sourceId)!.device_id;
    page.scopeAuthorityId = actor;
    const first = upsertWithCursorYieldable(db, page, { token: { requested: () => true } });
    if (first.kind !== "yield") throw new Error("Expected yield");
    db.prepare("UPDATE devices SET revoked_at=1 WHERE id=?").run(actor);
    const outcome = upsertWithCursorYieldable(db, first.resume, {
      token: { requested: () => false },
    });
    expect(outcome).toMatchObject({ kind: "done", value: { rejected: true } });
    expect(changed()).toEqual(["one"]);
    expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toEqual({ page: "before" });
  });
  it("preserves exclusive legacy shared-row admission for a non-owner hosting device", async () => {
    const actor = createDevice(db, { name: "Fictional legacy phone", kind: "ios" });
    const page = metadataPage();
    page.scopeAuthorityId = actor.id;
    page.requiredHostingAuthority = false;
    // The trusted admission policy also preserves old pages without any new scope fields.
    const legacy = await directWriteGate(db).upsertWithCursor({
      providerId,
      sourceId,
      scopeAuthorityId: actor.id,
      requiredHostingAuthority: false,
      hasMore: false,
      cursor: { page: "legacy-shared" },
    });
    expect(legacy.rejected).not.toBe(true);
    const first = upsertWithCursorYieldable(db, page, { token: { requested: () => true } });
    if (first.kind !== "yield") throw new Error("Expected yield");
    const complete = upsertWithCursorYieldable(db, first.resume, {
      token: { requested: () => false },
    });
    expect(complete).toMatchObject({ kind: "done" });
    if (complete.kind !== "done") throw new Error("Expected completion");
    expect(complete.value.rejected).not.toBe(true);
    expect(changed()).toEqual(["one", "three", "two"]);
  });
  it("rejects an actor that no longer hosts the source", () => {
    const page = metadataPage();
    page.scopeAuthorityId = db
      .prepare<[string], { device_id: string }>("SELECT device_id FROM sources WHERE id=?")
      .get(sourceId)!.device_id;
    const first = upsertWithCursorYieldable(db, page, { token: { requested: () => true } });
    if (first.kind !== "yield") throw new Error("Expected yield");
    const replacement = createDevice(db, {
      name: "Fictional replacement collector",
      kind: "collector",
    });
    db.prepare("UPDATE sources SET device_id=? WHERE id=?").run(replacement.id, sourceId);
    const outcome = upsertWithCursorYieldable(db, first.resume, {
      token: { requested: () => false },
    });
    expect(outcome).toMatchObject({ kind: "done", value: { rejected: true } });
    expect(changed()).toEqual(["one"]);
  });
  it("retains the operator identity's authorized shared-row metadata writes", () => {
    const page = metadataPage();
    page.scopeAuthorityId = createDevice(db, { name: "Fictional operator CLI", kind: "cli" }).id;
    const first = upsertWithCursorYieldable(db, page, { token: { requested: () => true } });
    if (first.kind !== "yield") throw new Error("Expected yield");
    const outcome = upsertWithCursorYieldable(db, first.resume, {
      token: { requested: () => false },
    });
    expect(outcome).toMatchObject({ kind: "done" });
    if (outcome.kind !== "done") throw new Error("Expected completion");
    expect(outcome.value.rejected).not.toBe(true);
    expect(changed()).toEqual(["one", "three", "two"]);
  });
  it("clears a historical catalogue in bounded prefixes before publishing its replacement", () => {
    const page = metadataPage();
    page.scopeUpdates!.documents = [];
    const insert = db.prepare(
      "INSERT INTO scope_entities(source_id,kind,entity_id,label) VALUES(?,'label',?,?)",
    );
    db.transaction(() => {
      for (let i = 0; i < 1000; i++)
        insert.run(sourceId, `historical-${i}`, `Fictional historical label ${i}`);
    })();
    let outcome = upsertWithCursorYieldable(db, page, { token: { requested: () => true } });
    expect(db.prepare("SELECT count(*) AS n FROM scope_entities WHERE kind='label'").get()).toEqual(
      { n: 872 },
    );
    expect(
      db.prepare("SELECT 1 FROM scope_entities WHERE entity_id='catalogue'").get(),
    ).toBeUndefined();
    let yields = 0;
    while (outcome.kind === "yield") {
      expect(++yields).toBeLessThan(20);
      expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toEqual({ page: "before" });
      outcome = upsertWithCursorYieldable(db, outcome.resume, { token: { requested: () => true } });
    }
    expect(yields).toBeGreaterThan(7);
    expect(db.prepare("SELECT entity_id FROM scope_entities WHERE kind='label'").all()).toEqual([
      { entity_id: "catalogue" },
    ]);
    expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toEqual({ page: "after" });
  });
  it("fences native labels when a trusted unsupported plain push actor returns", () => {
    upsertDocuments(db, [mail("old")]);
    const actor = db
      .prepare<[string], { device_id: string }>("SELECT device_id FROM sources WHERE id=?")
      .get(sourceId)!.device_id;
    expect(
      db.prepare("SELECT 1 FROM source_scope_refresh_requirements WHERE source_id=?").get(sourceId),
    ).toBeUndefined();
    upsertDocuments(db, [mail("new")], { scopeRefreshActorId: actor });
    expect(
      db
        .prepare("SELECT active FROM source_scope_refreshes WHERE source_id=? AND kind='label'")
        .get(sourceId),
    ).toEqual({ active: 1 });
    db.prepare("UPDATE devices SET revoked_at=1 WHERE id=?").run(actor);
    expect(
      upsertDocuments(db, [mail("refused")], { scopeRefreshActorId: actor }).rejectedSourceIds,
    ).toEqual([sourceId]);
    expect(db.prepare("SELECT 1 FROM documents WHERE external_id='refused'").get()).toBeUndefined();
  });
  it("also limits native document work on plain ingestion and its direct server fallback", async () => {
    const result = upsertDocuments(db, [mail("one"), mail("two"), mail("three")], {
      token: { requested: () => true },
      chunkSize: 50,
    });
    expect(result.remaining).toHaveLength(2);
    expect(db.prepare("SELECT count(*) AS n FROM documents").get()).toEqual({ n: 1 });
    const rest = directWriteGate(db).upsertDocuments(result.remaining);
    expect(db.prepare("SELECT count(*) AS n FROM documents").get()).toEqual({ n: 2 });
    await rest;
    expect(db.prepare("SELECT count(*) AS n FROM documents").get()).toEqual({ n: 3 });
  });
  it("resumes from consumed metadata tails and does not overwrite newer prefix state", () => {
    const first = upsertWithCursorYieldable(db, metadataPage(), {
      token: { requested: () => true },
    });
    if (first.kind !== "yield") throw new Error("Expected yield");
    upsertWithCursor(db, {
      sourceId,
      providerId,
      hasMore: false,
      cursor: { page: "before" },
      scopeUpdates: {
        documents: [
          {
            externalId: "one",
            kinds: ["label"],
            facts: {
              facts: [{ kind: "label", id: "newer" }],
              complete: ["label"],
            },
          },
        ],
      },
    });
    const outcome = upsertWithCursorYieldable(db, first.resume, {
      token: { requested: () => false },
    });
    expect(outcome.kind).toBe("done");
    expect(changed()).toEqual(["three", "two"]);
  });
});

it("drains a roster larger than one writer budget across metadata-only continuations", () => {
  const chatScopes: SourceScopes = {
    revision: 3,
    items: [
      {
        kind: "conversation",
        noun: { one: "conversation", many: "conversations" },
        picker: "search",
        link: "fixed",
      },
      { kind: "participant", identifiers: ["email"], link: "changes" },
    ],
    legacyProjection: {
      conversationIdPath: ["extra", "conversationId"],
      participants: { roles: ["participant"], membership: "conversation" },
    },
  };
  upsertSourceScopes(db, [{ sourceType: "fictional-mail", scopes: chatScopes }], 2);
  upsertWithCursor(db, { providerId, sourceId, hasMore: false, cursor: { page: "before-roster" } });
  const page: UpsertWithCursorArgs = {
    providerId,
    sourceId,
    hasMore: false,
    cursor: { page: "after-roster" },
    scopeUpdates: {
      conversations: [
        {
          id: "fictional-orbit-club",
          mode: "snapshot",
          observedAt: "2026-01-01T00:00:00.000Z",
          revision: { epoch: "fictional-native-epoch", sequence: 1 },
          participants: Array.from({ length: 300 }, (_, index) => ({
            role: "participant",
            emails: [`member-${index}@example.org`],
          })),
        },
      ],
    },
  };
  let outcome = upsertWithCursorYieldable(db, page, { token: { requested: () => true } });
  let yields = 0;
  while (outcome.kind === "yield") {
    yields++;
    expect(yields).toBeLessThan(40);
    expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toEqual({ page: "before-roster" });
    if (yields === 1) {
      expect(
        db
          .prepare("SELECT complete FROM document_scope_completeness WHERE kind='participant'")
          .all(),
      ).not.toContainEqual({ complete: 1 });
    }
    outcome = upsertWithCursorYieldable(db, outcome.resume, { token: { requested: () => true } });
  }
  expect(yields).toBeGreaterThan(2);
  expect(outcome.value.rejected).not.toBe(true);
  expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toEqual({ page: "after-roster" });
  expect(db.prepare("SELECT count(*) AS count FROM scope_conversation_members").get()).toEqual({
    count: 300,
  });
  expect(
    db.prepare("SELECT complete FROM document_scope_completeness WHERE kind='participant'").all(),
  ).toContainEqual({ complete: 1 });
});

it("publishes large label projections through bounded continuations before the cursor", () => {
  upsertWithCursor(db, {
    providerId,
    sourceId,
    documents: [mail()],
    hasMore: false,
    cursor: { page: "labels-before" },
  });
  const page: UpsertWithCursorArgs = {
    providerId,
    sourceId,
    hasMore: false,
    cursor: { page: "labels-after" },
    scopeUpdates: {
      documents: [
        {
          externalId: "message",
          kinds: ["label"],
          facts: {
            kinds: ["label"],
            complete: ["label"],
            facts: Array.from({ length: 400 }, (_, index) => ({
              kind: "label",
              id: `fictional-label-${index}`,
              label: `Fictional label ${index}`,
            })),
          },
        },
      ],
    },
  };
  let outcome = upsertWithCursorYieldable(db, page, { token: { requested: () => true } });
  expect(outcome.kind).toBe("yield");
  expect(visible("label-old")).toEqual([]);
  expect(visible("fictional-label-399")).toEqual([]);
  let yields = 0;
  while (outcome.kind === "yield") {
    expect(++yields).toBeLessThan(30);
    expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toEqual({ page: "labels-before" });
    outcome = upsertWithCursorYieldable(db, outcome.resume, { token: { requested: () => true } });
  }
  expect(yields).toBeGreaterThan(2);
  expect(visible("fictional-label-399")).toEqual(["message"]);
  expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toEqual({ page: "labels-after" });
});

it("does not adopt a newer sibling's fact rebuild after a metadata prefix yielded", () => {
  upsertWithCursor(db, {
    providerId,
    sourceId,
    documents: [mail()],
    hasMore: false,
    cursor: { page: "before-supersede" },
  });
  const labels = (prefix: string): NonNullable<UpsertWithCursorArgs["scopeUpdates"]> => ({
    documents: [
      {
        externalId: "message",
        kinds: ["label"],
        facts: {
          complete: ["label"],
          facts: Array.from({ length: 400 }, (_, index) => ({
            kind: "label",
            id: `${prefix}-${index}`,
          })),
        },
      },
    ],
  });
  const first = upsertWithCursorYieldable(
    db,
    {
      providerId,
      sourceId,
      hasMore: false,
      cursor: { page: "after-supersede" },
      scopeUpdates: labels("prior"),
    },
    { token: { requested: () => true } },
  );
  if (first.kind !== "yield") throw new Error("Expected yield");
  expect(first.resume.scopeFactRebuildTargets?.length).toBeGreaterThan(0);
  upsertWithCursor(db, {
    providerId,
    sourceId,
    hasMore: false,
    cursor: { page: "before-supersede" },
    scopeUpdates: labels("fresh"),
  });
  const resumed = upsertWithCursorYieldable(db, first.resume, { token: { requested: () => true } });
  expect(resumed.kind).toBe("done");
  expect(visible("prior-399")).toEqual([]);
  expect(visible("fresh-399")).toEqual([]);
  expect(JSON.parse(getSyncState(db, sourceId)!.cursor!)).toEqual({ page: "after-supersede" });
});
