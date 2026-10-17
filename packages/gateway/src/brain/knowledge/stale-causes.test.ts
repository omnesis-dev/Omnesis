// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KNOWLEDGE_STALE_CAUSE_LIMIT, readKnowledgeStaleCauses } from "./stale-causes.js";
import {
  createKnowledgeTables,
  getKnowledgeNode,
  recordKnowledgeSourceChange,
  saveKnowledgeNode,
} from "./storage.js";
import type { SaveKnowledgeNodeInput } from "./types.js";

let db: Database.Database;

function addDocument(id: string, title: string, hash = "hash-one"): void {
  db.prepare("INSERT INTO documents VALUES(?,?,?,?,?)").run(
    id,
    `${title} body.`,
    hash,
    title,
    "notes-test",
  );
}

function wiki(id: string, refs: string[], inputVersions: Record<string, string | number>) {
  const input: SaveKnowledgeNodeInput = {
    id,
    kind: "wiki",
    title: `Page ${id}`,
    markdown: `<claim id="fact" refs="${refs.join(" ")}">The workshop starts Friday.</claim>`,
    expectedRevision: 0,
    inputVersions,
  };
  return saveKnowledgeNode(db, input, 10);
}

function changeDocument(id: string): void {
  db.prepare("UPDATE documents SET content_hash='hash-two' WHERE id=?").run(id);
  recordKnowledgeSourceChange(db, { documentId: id, contentHash: "hash-two" }, 20);
}

const causes = (id: string) => readKnowledgeStaleCauses(db, getKnowledgeNode(db, id)!);

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT NOT NULL,content_hash TEXT NOT NULL,title TEXT NOT NULL,source_id TEXT NOT NULL)",
  );
  createKnowledgeTables(db);
  addDocument("agenda", "Workshop agenda");
  addDocument("venue", "Venue booking");
});
afterEach(() => db.close());

describe("readKnowledgeStaleCauses", () => {
  it("names a source document whose revision changed", () => {
    wiki("project", ["source:agenda", "source:venue"], {
      "source:agenda": "hash-one",
      "source:venue": "hash-one",
    });
    changeDocument("agenda");
    expect(getKnowledgeNode(db, "project")?.validity).toBe("stale");
    expect(causes("project")).toEqual({
      items: [
        {
          kind: "source",
          id: "agenda",
          title: "Workshop agenda",
          sourceId: "notes-test",
          change: "changed",
        },
      ],
      total: 1,
      reason: null,
    });
  });

  it("names a deleted source document without a title", () => {
    wiki("project", ["source:agenda"], { "source:agenda": "hash-one" });
    db.prepare("DELETE FROM documents WHERE id='agenda'").run();
    expect(causes("project").items).toEqual([
      { kind: "source", id: "agenda", title: null, sourceId: null, change: "deleted" },
    ]);
  });

  it("names the changed upstream page and the source behind it, sources first", () => {
    wiki("project", ["source:agenda"], { "source:agenda": "hash-one" });
    wiki("overview", ["wiki:project#claim:fact"], { "wiki:project#claim:fact": 1 });
    changeDocument("agenda");
    expect(causes("overview").items).toEqual([
      expect.objectContaining({ kind: "source", id: "agenda", change: "changed" }),
      {
        kind: "node",
        id: "project",
        nodeKind: "wiki",
        title: "Page project",
        change: "changed",
      },
    ]);
  });

  it("names a page whose owner has an update not yet mirrored", () => {
    wiki("project", ["source:agenda"], { "source:agenda": "hash-one" });
    db.prepare(
      "INSERT INTO knowledge_owner_changes(kind,owner_id,operation,changed_at) VALUES('wiki','project','update',30)",
    ).run();
    expect(causes("project").items).toEqual([
      expect.objectContaining({ kind: "node", id: "project", change: "owner_changed" }),
    ]);
  });

  it("explains a stale page whose claims wait for verification when nothing it reads changed", () => {
    wiki("project", ["source:agenda"], { "source:agenda": "hash-one" });
    db.prepare("UPDATE knowledge_nodes SET validity='stale' WHERE id='project'").run();
    expect(causes("project")).toEqual({ items: [], total: 0, reason: "claims_pending" });
  });

  it("explains a withdrawn page", () => {
    wiki("project", ["source:agenda"], { "source:agenda": "hash-one" });
    db.prepare(
      "UPDATE knowledge_nodes SET validity='stale',fields_json=json_set(fields_json,'$.withdrawn',json('true')) WHERE id='project'",
    ).run();
    expect(causes("project").reason).toBe("withdrawn");
  });

  it("lists a bounded number of records and counts the rest", () => {
    const refs: string[] = [];
    const versions: Record<string, string> = {};
    for (let index = 0; index < KNOWLEDGE_STALE_CAUSE_LIMIT + 2; index++) {
      const id = `note-${String(index).padStart(2, "0")}`;
      addDocument(id, `Note ${index}`);
      refs.push(`source:${id}`);
      versions[`source:${id}`] = "hash-one";
    }
    wiki("project", refs, versions);
    for (const ref of refs) changeDocument(ref.slice(7));
    const result = causes("project");
    expect(result.total).toBe(KNOWLEDGE_STALE_CAUSE_LIMIT + 2);
    expect(result.items).toHaveLength(KNOWLEDGE_STALE_CAUSE_LIMIT);
    expect(result.items[0]).toMatchObject({ id: "note-00" });
  });
});
