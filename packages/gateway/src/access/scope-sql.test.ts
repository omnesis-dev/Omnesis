// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createScopeFactsSchema } from "./scope-schema.js";
import { scopePolicySql, sourceScopeInclusionSql } from "./scope-sql.js";
import type { ScopePolicy, ScopeRef } from "@omnesis/types";

describe("scope SQL decisions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("CREATE TABLE documents (id TEXT PRIMARY KEY, source_id TEXT NOT NULL)");
    createScopeFactsSchema(db);
    createScopeFactsSchema(db);
    db.prepare(
      "INSERT INTO scope_fact_backfill (source_id, source_type, descriptor_json, ready) VALUES (?, ?, '{}', 1)",
    ).run("test:one", "test");
  });
  afterEach(() => db.close());

  function document(id: string, source = "test:one"): void {
    db.prepare("INSERT INTO documents VALUES (?, ?)").run(id, source);
  }
  function facts(id: string, kind: ScopeRef["kind"], values: string[], complete = true): void {
    db.prepare("INSERT INTO document_scope_completeness VALUES (?, ?, ?)").run(id, kind, +complete);
    for (const value of values)
      db.prepare("INSERT INTO document_scope_facts VALUES (?, ?, ?)").run(id, kind, value);
  }
  function policy(match: ScopeRef[], mode: "only" | "except" = "only"): ScopePolicy {
    return {
      sourceId: "test:one",
      audience: { accessLevel: "level", capability: "direct" },
      rules: [{ match, action: mode === "only" ? "share" : "hide" }],
      otherwise: mode === "only" ? "hide" : "share",
    };
  }
  function visible(policies: ScopePolicy[]): string[] {
    const restriction = sourceScopeInclusionSql(policies, "d.id", "d.source_id");
    return db
      .prepare<string[], { id: string }>(
        `SELECT d.id FROM documents d WHERE ${restriction.sql} ORDER BY d.id`,
      )
      .all(...restriction.params)
      .map((row) => row.id);
  }

  it.each(["conversation", "label", "folder"] as const)(
    "enforces both list modes on stable %s IDs and hides missing facts",
    (kind) => {
      for (const id of ["match", "other", "empty", "missing", "pending"]) document(id);
      facts("match", kind, ["selected"]);
      facts("other", kind, ["different"]);
      facts("empty", kind, []);
      facts("pending", kind, ["different"], false);
      document("unfiltered", "test:two");
      const ref: ScopeRef = { kind, id: "selected" };
      expect(visible([policy([ref])])).toEqual(["match", "unfiltered"]);
      expect(visible([policy([ref], "except")])).toEqual(["empty", "other", "unfiltered"]);
      expect(visible([])).toEqual(["empty", "match", "missing", "other", "pending", "unfiltered"]);
    },
  );

  it.each(["only", "except"] as const)("empty %s list needs no facts or backfill", (mode) => {
    document("unproven");
    db.prepare("UPDATE scope_fact_backfill SET ready=0").run();
    expect(visible([policy([], mode)])).toEqual(mode === "only" ? [] : ["unproven"]);
    db.prepare("DELETE FROM scope_fact_backfill").run();
    expect(visible([policy([], mode)])).toEqual(mode === "only" ? [] : ["unproven"]);
  });

  it("matches saved participant identifiers without consulting mutable people rows", () => {
    document("with-contact");
    document("other-contact");
    document("unresolved");
    facts("with-contact", "participant", ["phone:+15550100123", "email:contact@example.org"]);
    facts("other-contact", "participant", ["phone:+15550100456"]);
    facts("unresolved", "participant", ["phone:+15550100123"], false);
    const ref: ScopeRef = {
      kind: "participant",
      label: "Display only",
      identifiers: [{ type: "phone", value: "+15550100123" }],
    };
    expect(visible([policy([ref])])).toEqual(["with-contact"]);
    expect(visible([policy([ref], "except")])).toEqual(["other-contact"]);
    expect(visible([policy([{ ...ref, label: "Renamed display" }])])).toEqual(["with-contact"]);
  });

  it("ORs mixed refs but requires every relevant kind to be complete", () => {
    for (const id of ["chat", "person", "neither", "unknown"]) document(id);
    for (const id of ["chat", "person", "neither", "unknown"]) {
      facts(id, "conversation", [id === "chat" || id === "unknown" ? "selected" : "other"]);
      facts(
        id,
        "participant",
        id === "person" ? ["email:contact@example.org"] : [],
        id !== "unknown",
      );
    }
    const refs: ScopeRef[] = [
      { kind: "conversation", id: "selected" },
      {
        kind: "participant",
        label: "Contact",
        identifiers: [{ type: "email", value: "contact@example.org" }],
      },
    ];
    expect(visible([policy(refs)])).toEqual(["chat", "person"]);
    expect(visible([policy(refs, "except")])).toEqual(["neither"]);
  });

  it("isolates source accounts with identically named entities", () => {
    document("first");
    document("second", "test:two");
    facts("first", "conversation", ["chat"]);
    facts("second", "conversation", ["chat"]);
    expect(visible([policy([{ kind: "conversation", id: "chat" }], "except")])).toEqual(["second"]);
  });

  it("uses transitive folder facts and immediately hides an incomplete recompute", () => {
    document("nested");
    facts("nested", "folder", ["root", "child"]);
    const filter = policy([{ kind: "folder", id: "root" }]);
    expect(visible([filter])).toEqual(["nested"]);
    db.prepare("UPDATE document_scope_completeness SET complete = 0 WHERE document_id = ?").run(
      "nested",
    );
    expect(visible([filter])).toEqual([]);
    expect(visible([policy([{ kind: "folder", id: "elsewhere" }], "except")])).toEqual([]);
    db.prepare("DELETE FROM document_scope_facts WHERE entity_id = ?").run("root");
    db.prepare("UPDATE document_scope_completeness SET complete = 1").run();
    expect(visible([filter])).toEqual([]);
  });

  it("binds untrusted IDs and rejects SQL identifiers from requests", () => {
    document("safe");
    facts("safe", "conversation", ["ordinary"]);
    expect(visible([policy([{ kind: "conversation", id: "' OR 1=1 --" }])])).toEqual([]);
    expect(() =>
      scopePolicySql(policy([{ kind: "conversation", id: "x" }]), "id) OR 1=1 --"),
    ).toThrow(/column/);
  });

  it.each([
    "document_id",
    "kind",
    "entity_id",
    "sf.document_id",
    "SC.document_id",
    "ss.document_id",
    "sb.source_id",
  ])("refuses a document column that could shadow the outer row: %s", (documentColumn) => {
    expect(() =>
      scopePolicySql(policy([{ kind: "conversation", id: "chat" }]), documentColumn),
    ).toThrow(/column/);
  });

  it("refuses unsafe source columns even when there is no filter", () => {
    expect(() => sourceScopeInclusionSql([], "d.id", "source_id")).toThrow(/column/);
    expect(() => sourceScopeInclusionSql([], "d.id", "d.source_id OR 1=1")).toThrow(/column/);
  });

  it("denies a source during initial or restarted backfill even when old facts match", () => {
    document("safe");
    facts("safe", "conversation", ["chat"]);
    const filter = policy([{ kind: "conversation", id: "chat" }]);
    expect(visible([filter])).toEqual(["safe"]);
    db.prepare("UPDATE scope_fact_backfill SET ready = 0").run();
    expect(visible([filter])).toEqual([]);
    expect(visible([])).toEqual(["safe"]);
  });

  it("gives attachments their parent's decision and hides unresolved parents", () => {
    for (const id of ["parent", "child", "orphan"]) document(id);
    facts("parent", "conversation", ["chat"]);
    // Even child-supplied positive facts cannot override its missing parent.
    facts("orphan", "conversation", ["chat"]);
    db.prepare(
      "INSERT INTO document_scope_subjects (document_id,subject_document_id) VALUES (?, ?)",
    ).run("child", "parent");
    db.prepare(
      "INSERT INTO document_scope_subjects (document_id,subject_document_id) VALUES (?, ?)",
    ).run("orphan", "");
    expect(visible([policy([{ kind: "conversation", id: "chat" }])])).toEqual(["child", "parent"]);
    expect(visible([policy([{ kind: "conversation", id: "chat" }], "except")])).toEqual([]);
    db.prepare("DELETE FROM documents WHERE id = 'parent'").run();
    expect(visible([policy([{ kind: "conversation", id: "chat" }])])).toEqual([]);
  });

  it("keeps SQL bindings bounded for large lists by encoding each kind once", () => {
    const filter = policy(
      Array.from({ length: 256 }, (_, index) => ({ kind: "conversation", id: `chat-${index}` })),
    );
    const compiled = scopePolicySql(filter, "d.id");
    expect(compiled.params).toHaveLength(4);
    expect(compiled.sql).toContain("json_each(?)");
  });

  it("fences explicit metadata refreshes without treating editor readiness as an enforcement switch", () => {
    document("known-label");
    facts("known-label", "label", ["Label_native"]);
    const filter = policy([{ kind: "label", id: "Label_native" }]);
    db.prepare("INSERT INTO source_scope_kind_readiness VALUES('test:one','label',0)").run();
    expect(visible([filter])).toEqual(["known-label"]);
    db.prepare("INSERT INTO source_scope_refreshes VALUES('test:one','folder',1)").run();
    expect(visible([filter])).toEqual(["known-label"]);
    db.prepare("INSERT INTO source_scope_refreshes VALUES('test:one','label',1)").run();
    expect(visible([filter])).toEqual([]);
    db.prepare("UPDATE source_scope_refreshes SET active=0 WHERE kind='label'").run();
    expect(visible([filter])).toEqual(["known-label"]);
  });

  it("denies reserved actions and unimplemented maxAge", () => {
    document("safe");
    facts("safe", "conversation", ["chat"]);
    const filter = policy([{ kind: "conversation", id: "chat" }]);
    filter.rules[0]!.action = "ask";
    expect(visible([filter])).toEqual([]);
    filter.rules[0]!.action = "share";
    filter.maxAge = "90d";
    expect(visible([filter])).toEqual([]);
  });

  it("compiles ordered first-match rules for the reserved V2 model", () => {
    document("safe");
    facts("safe", "conversation", ["chat"]);
    const filter = policy([{ kind: "conversation", id: "chat" }]);
    filter.rules.unshift({ match: [{ kind: "conversation", id: "chat" }], action: "hide" });
    expect(visible([filter])).toEqual([]);
  });
});
