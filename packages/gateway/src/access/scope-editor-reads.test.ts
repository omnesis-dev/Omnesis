// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { upsertSourceScopes } from "./scope-descriptors.js";
import { replaceDocumentScopeFacts } from "./scope-facts.js";
import { readSourceScopeOptions, readSourceScopePreview } from "./scope-editor-reads.js";
import { sourceScopeReadiness } from "./scope-editor-readiness.js";
import type { DocumentScopeFacts, ScopePolicy, ScopeRef, SourceScopes } from "@omnesis/types";

const sourceId = "fictional:one";
const scopes: SourceScopes = {
  items: [
    {
      kind: "conversation",
      noun: { one: "conversation", many: "conversations" },
      picker: "search",
      link: "fixed",
    },
    { kind: "participant", identifiers: ["email", "phone", "domain"], link: "fixed" },
    { kind: "label", noun: { one: "label", many: "labels" }, picker: "search", link: "changes" },
    { kind: "folder", noun: { one: "folder", many: "folders" }, picker: "tree", link: "hierarchy" },
  ],
};
const participant: ScopeRef = {
  kind: "participant",
  label: "Fictional correspondent",
  identifiers: [{ type: "email", value: "fictional@example.org" }],
};
function policy(refs: ScopeRef[], action: "share" | "hide" = "share"): ScopePolicy {
  return {
    sourceId,
    audience: { accessLevel: "new", capability: "direct" },
    rules: [{ match: refs, action }],
    otherwise: action === "share" ? "hide" : "share",
  };
}
describe("source filter owner reads", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runSchemaSetup(db);
    db.prepare(
      "INSERT INTO devices(id,name,kind,paired_at,capabilities) VALUES('00000000-0000-4000-8000-000000000001','Fictional collector','collector',1,?)",
    ).run(JSON.stringify({ sourceScopes: { min: 1, max: 2 } }));
    for (const id of [sourceId, "fictional:two"])
      db.prepare(
        "INSERT INTO sources(id,type,account_id,device_id,created_at,updated_at) VALUES(?,'fictional',?,'00000000-0000-4000-8000-000000000001',1,1)",
      ).run(id, id);
    upsertSourceScopes(db, [{ sourceType: "fictional", scopes }], 1);
    for (const id of [sourceId, "fictional:two"])
      db.prepare(
        "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready,processed) VALUES(?,'fictional',?,1,3)",
      ).run(id, JSON.stringify(scopes));
    for (const kind of ["label", "folder"])
      db.prepare("INSERT INTO source_scope_kind_readiness VALUES(?,?,1)").run(sourceId, kind);
  });
  afterEach(() => db.close());
  function document(id: string, facts: DocumentScopeFacts, source = sourceId): void {
    db.prepare(
      `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at)
      VALUES(?,'fictional',?,?,?,'Invented content','hash','{}','2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
    ).run(id, source, id, `Fictional ${id}`);
    replaceDocumentScopeFacts(db, id, facts);
    // This fixture installs trusted facts directly rather than simulating a legacy writer.
    db.prepare("DELETE FROM scope_native_reprojection WHERE document_id=?").run(id);
  }
  function entity(
    id: string,
    label: string,
    kind = "conversation",
    parent: string | null = null,
  ): void {
    db.prepare("INSERT INTO scope_entities VALUES(?,?,?,?,?)").run(
      sourceId,
      kind,
      id,
      label,
      parent,
    );
  }
  function person(
    id: string,
    name: string,
    aliases: Array<[string, string]>,
    mergedInto: string | null = null,
  ): void {
    db.prepare(
      "INSERT INTO people(id,canonical_name,merged_into,source,first_seen,last_seen,created_at,updated_at) VALUES(?,?,?,'fictional','2026-01-01','2026-01-01','2026-01-01','2026-01-01')",
    ).run(id, name, mergedInto);
    for (const [index, [type, value]] of aliases.entries())
      db.prepare(
        "INSERT INTO person_aliases(id,person_id,alias_type,alias,created_at) VALUES(?,?,?,?,'2026-01-01')",
      ).run(`${id}-${index}`, id, type, value);
  }
  test("a full catalogue page counts each item exactly across aggregate groups", () => {
    for (let index = 0; index < 51; index++) {
      const id = `group-${String(index).padStart(2, "0")}`;
      entity(id, `Invented ${id}`);
      if (index % 2 === 0)
        document(`doc-${id}`, {
          facts: [{ kind: "conversation", id }],
          complete: ["conversation"],
        });
    }
    const result = readSourceScopeOptions(db, { sourceId, kind: "conversation" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(50);
    expect(result.value.nextCursor).toEqual(expect.any(String));
    expect(result.value.items.map((item) => item.count)).toEqual(
      Array.from({ length: 50 }, (_, index) => (index % 2 === 0 ? 1 : 0)),
    );
  });
  test.each(["share", "hide"] as const)(
    "preview %s agrees with enforcement for unknown facts and inherited attachments",
    (action) => {
      entity("chosen", "Invented group");
      document("chosen", {
        facts: [{ kind: "conversation", id: "chosen" }],
        complete: ["conversation"],
      });
      document("other", {
        facts: [{ kind: "conversation", id: "other" }],
        complete: ["conversation"],
      });
      document("unknown", { facts: [], complete: [] });
      document("attachment", { facts: [], complete: [] });
      db.prepare(
        "INSERT INTO document_scope_subjects(document_id,subject_document_id) VALUES('attachment','chosen')",
      ).run();
      document(
        "sibling",
        { facts: [{ kind: "conversation", id: "chosen" }], complete: ["conversation"] },
        "fictional:two",
      );
      const result = readSourceScopePreview(
        db,
        sourceId,
        policy([{ kind: "conversation", id: "chosen" }], action),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        total: 4,
        visible: action === "share" ? 2 : 1,
        hidden: action === "share" ? 2 : 3,
        unknown: 1,
        items: [{ label: "Invented group", count: 2 }],
      });
      expect(
        result.value.samples.find((sample) => sample.documentId === "attachment")?.visible,
      ).toBe(action === "share");
      expect(result.value.samples.find((sample) => sample.documentId === "unknown")).toMatchObject({
        visible: false,
        unknown: true,
      });
    },
  );
  test("mixed positive matches still count incomplete required kinds as unknown", () => {
    document("partial", {
      facts: [{ kind: "conversation", id: "chosen" }],
      complete: ["conversation"],
    });
    const result = readSourceScopePreview(
      db,
      sourceId,
      policy([{ kind: "conversation", id: "chosen" }, participant]),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { total: 1, visible: 0, unknown: 1, hidden: 1 },
    });
  });
  test("native refresh fences preview and temporarily withholds stale picker suggestions", () => {
    entity("label", "Invented label", "label");
    document("mail", { facts: [{ kind: "label", id: "label" }], complete: ["label"] });
    db.prepare("INSERT INTO source_scope_refreshes VALUES(?,'label',1)").run(sourceId);
    expect(
      readSourceScopePreview(db, sourceId, policy([{ kind: "label", id: "label" }])),
    ).toMatchObject({ ok: true, value: { visible: 0, unknown: 1 } });
    expect(readSourceScopeOptions(db, { sourceId, kind: "label" })).toMatchObject({
      ok: true,
      value: {
        items: [],
        readiness: expect.arrayContaining([
          expect.objectContaining({ kind: "label", ready: false }),
        ]),
      },
    });
  });
  test("keyset pagination is isolated by account, kind and query", () => {
    for (let i = 0; i < 55; i++)
      entity(`chat-${i.toString().padStart(2, "0")}`, `Invented ${i.toString().padStart(2, "0")}`);
    const first = readSourceScopeOptions(db, { sourceId, kind: "conversation" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.items).toHaveLength(50);
    expect(first.value.nextCursor).toBeTypeOf("string");
    const second = readSourceScopeOptions(db, {
      sourceId,
      kind: "conversation",
      cursor: first.value.nextCursor,
    });
    expect(second).toMatchObject({
      ok: true,
      value: { items: expect.arrayContaining([expect.objectContaining({ label: "Invented 50" })]) },
    });
    if (second.ok) expect(second.value.items).toHaveLength(5);
    for (const request of [
      { sourceId: "fictional:two", kind: "conversation" as const },
      { sourceId, kind: "label" as const },
      { sourceId, kind: "conversation" as const, q: "changed" },
    ])
      expect(
        readSourceScopeOptions(db, { ...request, cursor: first.value.nextCursor }),
      ).toMatchObject({ ok: false, error: "invalid-cursor" });
    expect(
      readSourceScopeOptions(db, { sourceId, kind: "conversation", q: "%' OR 1=1 --" }),
    ).toMatchObject({ ok: true, value: { items: [] } });
  });
  test("folder options browse a tree, while search reaches descendants", () => {
    entity("root", "Invented root", "folder");
    entity("child", "Invented child", "folder", "root");
    entity("leaf", "Invented leaf", "folder", "child");
    expect(readSourceScopeOptions(db, { sourceId, kind: "folder" })).toMatchObject({
      ok: true,
      value: { items: [{ ref: { kind: "folder", id: "root" }, hasChildren: true }] },
    });
    expect(
      readSourceScopeOptions(db, { sourceId, kind: "folder", parentId: "root" }),
    ).toMatchObject({
      ok: true,
      value: {
        items: [{ ref: { kind: "folder", id: "child" }, parentId: "root", hasChildren: true }],
      },
    });
    expect(readSourceScopeOptions(db, { sourceId, kind: "folder", q: "leaf" })).toMatchObject({
      ok: true,
      value: { items: [{ ref: { kind: "folder", id: "leaf" }, parentId: "child" }] },
    });
  });
  test("people suggestions use typed snapshots and proposals require explicit acceptance", () => {
    person("person", "Fictional correspondent", [["email", "fictional@example.org"]]);
    person(
      "merged",
      "Invented additional identity",
      [
        ["email", "new@example.org"],
        ["phone", "+15550100123"],
      ],
      "person",
    );
    document("mail", {
      facts: [
        { kind: "participant", identifier: { type: "email", value: "fictional@example.org" } },
      ],
      complete: ["participant"],
    });
    const saved = policy([participant]);
    const result = readSourceScopePreview(db, sourceId, saved);
    expect(result).toMatchObject({
      ok: true,
      value: {
        visible: 1,
        identifierProposals: [
          {
            itemIndex: 0,
            identifiers: expect.arrayContaining([
              { type: "email", value: "new@example.org" },
              { type: "phone", value: "+15550100123" },
            ]),
          },
        ],
      },
    });
    expect(saved.rules[0]!.match).toEqual([participant]);
    const options = readSourceScopeOptions(db, { sourceId, kind: "participant", q: "Fictional" });
    expect(options).toMatchObject({
      ok: true,
      value: {
        items: [
          {
            personId: "person",
            count: 1,
            ref: {
              kind: "participant",
              identifiers: expect.arrayContaining([
                { type: "email", value: "fictional@example.org" },
                { type: "email", value: "new@example.org" },
              ]),
            },
          },
        ],
      },
    });
  });
  test("ambiguous saved identifiers and whole domains never propose arbitrary identities", () => {
    person("one", "Fictional one", [
      ["email", "fictional@example.org"],
      ["email", "one@example.org"],
    ]);
    person("two", "Fictional two", [
      ["email", "fictional@example.org"],
      ["email", "two@example.org"],
    ]);
    expect(readSourceScopePreview(db, sourceId, policy([participant]))).toMatchObject({
      ok: true,
      value: { identifierProposals: [] },
    });
    expect(
      readSourceScopePreview(
        db,
        sourceId,
        policy([
          {
            kind: "participant",
            label: "Invented domain",
            identifiers: [{ type: "domain", value: "example.org" }],
          },
        ]),
      ),
    ).toMatchObject({ ok: true, value: { identifierProposals: [] } });
  });
  test("unknown IDs remain selected and account substitutions are refused", () => {
    expect(
      readSourceScopePreview(db, sourceId, policy([{ kind: "conversation", id: "deleted" }])),
    ).toMatchObject({
      ok: true,
      value: { items: [{ label: "deleted", missing: true, count: 0 }] },
    });
    expect(readSourceScopePreview(db, "fictional:two", policy([]))).toEqual({
      ok: false,
      error: "invalid-policy",
    });
    expect(readSourceScopeOptions(db, { sourceId: "fictional:missing", kind: "label" })).toEqual({
      ok: false,
      error: "source-not-found",
    });
  });
  test("readiness names legacy collectors and distinguishes hierarchy protocol versions", () => {
    db.prepare("UPDATE devices SET capabilities=?").run(
      JSON.stringify({ sourceScopes: { min: 1, max: 1 } }),
    );
    const state = sourceScopeReadiness(db, sourceId);
    expect(state.find((item) => item.kind === "label")?.behindCollectors).toBeUndefined();
    expect(state.find((item) => item.kind === "folder")?.behindCollectors).toEqual([
      { deviceId: "00000000-0000-4000-8000-000000000001", name: "Fictional collector" },
    ]);
    db.prepare("UPDATE scope_fact_backfill SET ready=0,processed=17 WHERE source_id=?").run(
      sourceId,
    );
    expect(sourceScopeReadiness(db, sourceId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "conversation",
          ready: false,
          reason: "backfill",
          processed: 17,
        }),
      ]),
    );
  });
});
