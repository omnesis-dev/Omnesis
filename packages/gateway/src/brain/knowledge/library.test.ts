// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createKnowledgeTables } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { readKnowledgeLibrary, readKnowledgeLibraryRetirement } from "./library.js";
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT)");
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
});
afterEach(() => db.close());
function loop(id: string, state = "open", at = 10) {
  db.prepare(
    "INSERT INTO open_loops(id,created_by_run,state,confidence,importance,title,description,created_at,last_update) VALUES(?,'fixture',?,0.7,0.4,?,'Loop description',1,?)",
  ).run(id, state, id, at);
}
function retired(id: string, at = 9) {
  db.prepare(
    "INSERT INTO retired_loops(id,title,title_norm,description,outcome,importance,created_at,retired_at,recurrence_count,cadence_days) VALUES(?,?,?,'Historical description','done',0.4,1,?,3,7)",
  ).run(id, id, id, at);
}
function wiki(id: string, kind = "wiki") {
  db.prepare(
    "INSERT INTO knowledge_nodes(id,kind,owner_id,title,markdown,plain_text,revision,meaning_revision,meaning_hash,validity,metadata_json,fields_json,created_at,updated_at) VALUES(?,?,NULL,?,'text','text',1,1,'hash','current','{}','{}',1,10)",
  ).run(id, kind, id);
}
function brief(id: string, state = "unread") {
  db.prepare(
    "INSERT INTO briefs(id,created_by_run,kind,title,description,confidence,urgency,state,created_at,updated_at) VALUES(?,'fixture','notice',?,'Brief description',0.8,0.2,?,1,10)",
  ).run(id, id, state);
}
it("pages one canonical library including unmirrored owners and retired-only traces without duplicates", () => {
  loop("loop-active");
  loop("loop-resolved", "done");
  retired("loop-resolved");
  retired("loop-gone");
  brief("brief-unread");
  wiki("wiki-page");
  wiki("loop-active", "loop");
  wiki("brief-unread", "brief");
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = readKnowledgeLibrary(db, { limit: 2, ...(cursor ? { cursor } : {}) });
    ids.push(...page.items.map((item) => item.id));
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  expect(new Set(ids).size).toBe(5);
  expect(ids).toHaveLength(5);
  const resolved = readKnowledgeLibrary(db, { kind: "loop", status: "resolved" }).items;
  expect(resolved).toHaveLength(1);
  expect(resolved[0]!.canonicalFields).toMatchObject({
    state: "done",
    recurrenceCount: 3,
    cadenceDays: 7,
  });
  expect(
    readKnowledgeLibrary(db, { kind: "loop", status: "active" }).items.map((x) => x.id),
  ).toEqual(["loop-active"]);
  expect(
    readKnowledgeLibrary(db, { kind: "loop", status: "retired" }).items.map((x) => x.id),
  ).toEqual(["retired-loop:loop-gone"]);
  expect(
    readKnowledgeLibraryRetirement(db, "retired-loop:loop-gone").canonicalFields,
  ).toMatchObject({ retired: true, originalLoopId: "loop-gone", recurrenceCount: 3 });
});
it("filters brief states before paging and rejects cross-filter or stale cursors", () => {
  brief("one");
  brief("two");
  brief("dismissed", "dismissed_acknowledged");
  brief("snoozed", "dismissed_snoozed");
  expect(
    readKnowledgeLibrary(db, { kind: "brief", status: "snoozed" }).items.map((x) => x.id),
  ).toEqual(["snoozed"]);
  expect(
    readKnowledgeLibrary(db, { kind: "brief", status: "dismissed" }).items.map((x) => x.id),
  ).toEqual(["dismissed"]);
  const first = readKnowledgeLibrary(db, { kind: "brief", status: "unread", limit: 1 });
  expect(first.items).toHaveLength(1);
  expect(first.pageInfo.hasMore).toBe(true);
  expect(() =>
    readKnowledgeLibrary(db, { kind: "brief", status: "read", cursor: first.pageInfo.nextCursor! }),
  ).toThrow("Invalid pagination cursor");
  db.prepare("UPDATE briefs SET state='read' WHERE id='one'").run();
  expect(() =>
    readKnowledgeLibrary(db, {
      kind: "brief",
      status: "unread",
      cursor: first.pageInfo.nextCursor!,
    }),
  ).toThrow("list changed");
});
it("filters privacy-hidden owners and retirement ancestry before page limit and detail", () => {
  loop("hidden");
  loop("visible");
  retired("gone");
  db.prepare("INSERT INTO knowledge_node_tombstones(id,deleted_at) VALUES('hidden',1)").run();
  db.prepare(
    "INSERT INTO knowledge_retired_loop_sources(loop_id,document_id) VALUES('gone','secret')",
  ).run();
  db.prepare(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('secret','v1',1,1)",
  ).run();
  expect(readKnowledgeLibrary(db, { kind: "loop", limit: 1 }).items.map((x) => x.id)).toEqual([
    "visible",
  ]);
  expect(() => readKnowledgeLibraryRetirement(db, "retired-loop:gone")).toThrow("not found");
});

it("invalidates paging on wiki edits, retirement-only changes and journaled annotation mirror movement", () => {
  wiki("page-one");
  wiki("page-two");
  const page = () => readKnowledgeLibrary(db, { limit: 1 });
  let first = page();
  db.prepare("UPDATE knowledge_nodes SET title='Updated' WHERE id='page-one'").run();
  expect(() => readKnowledgeLibrary(db, { limit: 1, cursor: first.pageInfo.nextCursor! })).toThrow(
    "list changed",
  );
  first = page();
  retired("trace");
  expect(() => readKnowledgeLibrary(db, { limit: 1, cursor: first.pageInfo.nextCursor! })).toThrow(
    "list changed",
  );
  wiki("annotation", "doc_annotation");
  first = page();
  db.transaction(() => {
    db.prepare(
      "UPDATE knowledge_nodes SET updated_at=50,revision=revision+1 WHERE id='annotation'",
    ).run();
    db.prepare(
      "INSERT INTO knowledge_changes(kind,entity_id,revision,at) VALUES('node_invalidated','annotation','2',50)",
    ).run();
  })();
  expect(() => readKnowledgeLibrary(db, { limit: 1, cursor: first.pageInfo.nextCursor! })).toThrow(
    "list changed",
  );
});

it.each(["loop", "brief"] as const)(
  "preserves stored and dynamic %s mirror freshness without classifying unmirrored owners",
  (kind) => {
    const create = kind === "loop" ? loop : brief;
    create("mirrored");
    create("unmirrored");
    wiki("mirrored", kind);
    db.prepare("INSERT INTO documents VALUES('evidence','Original source','v1')").run();
    db.prepare(
      "INSERT INTO knowledge_claims(node_id,id,text,span_start,span_end,support_logic,verification,fingerprint,meaning_revision,meaning_hash) VALUES('mirrored','summary','text',0,4,'all','verified','claim-v1',1,'meaning-v1')",
    ).run();
    db.prepare(
      `INSERT INTO knowledge_dependencies VALUES('mirrored','summary','source:evidence','evidence','source','support','"v1"')`,
    ).run();
    const freshness = () =>
      Object.fromEntries(
        readKnowledgeLibrary(db, { kind }).items.map((row) => [row.id, row.validity]),
      );
    expect(freshness()).toEqual({ mirrored: "current", unmirrored: null });

    // The source changes before the asynchronous mirror repair runs.
    db.prepare(
      "UPDATE documents SET content='Changed source',content_hash='v2' WHERE id='evidence'",
    ).run();
    expect(freshness()).toEqual({ mirrored: "stale", unmirrored: null });
    expect(db.prepare("SELECT validity FROM knowledge_nodes WHERE id='mirrored'").get()).toEqual({
      validity: "current",
    });

    db.prepare("UPDATE documents SET content_hash='v1' WHERE id='evidence'").run();
    db.prepare("UPDATE knowledge_nodes SET validity='stale' WHERE id='mirrored'").run();
    expect(freshness()).toEqual({ mirrored: "stale", unmirrored: null });
  },
);
