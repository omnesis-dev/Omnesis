// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createAnnotationStorageTables } from "../storage/annotations.js";
import { createPersonAnnotationStorageTables } from "../storage/person-annotations.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { KnowledgeQueryService } from "./query-service.js";
import { createKnowledgeTables } from "./storage.js";
import { withdrawKnowledgeOwner } from "./owner-withdrawal.js";
import { convertKnowledgeOwner } from "./owner-adapters.js";
import { readKnowledgeSubjectRef } from "./subject-ref.js";
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

function personNote() {
  createPersonAnnotationStorageTables(db);
  db.exec(
    "CREATE TABLE people(id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL, merged_into TEXT)",
  );
  db.exec(
    "INSERT INTO people VALUES('old-person','Old display name','current-person'),('current-person','Maya Reeves',NULL)",
  );
  db.prepare(
    "INSERT INTO person_annotations(id,person_id,claim_type,claim_text,evidence_doc_id,evidence_quote,confidence,created_by_run,created_at) VALUES('note-owner','old-person','preference','Prefers printed instructions','evidence','Printed instructions',0.9,'fixture',1)",
  ).run();
  wiki("note-node", "person_annotation");
  db.prepare(
    "UPDATE knowledge_nodes SET owner_id='note-owner',fields_json=? WHERE id='note-node'",
  ).run(JSON.stringify({ subjectId: "wrong-person", personName: "Stale name" }));
}

it("serves current canonical person subjects on both bounded Library cards and detail, following merges", () => {
  personNote();
  const detail = new KnowledgeQueryService(db);
  const subject = { kind: "person", id: "current-person", name: "Maya Reeves" };
  expect(
    readKnowledgeLibrary(db, { kind: "person_annotation", limit: 1 }).items[0]?.subjectRef,
  ).toEqual(subject);
  expect(detail.fetch("note-node").subjectRef).toEqual(subject);
  db.prepare("UPDATE people SET canonical_name='Maya R.' WHERE id='current-person'").run();
  expect(detail.fetch("note-node").subjectRef).toMatchObject({ name: "Maya R." });
  wiki("ordinary-wiki");
  expect(detail.fetch("ordinary-wiki").subjectRef).toBeNull();
});

it("does not reconstruct subjects from stale fields when canonical owners or merged targets are unavailable", () => {
  personNote();
  const detail = new KnowledgeQueryService(db);
  db.prepare("UPDATE people SET merged_into='missing-person' WHERE id='current-person'").run();
  expect(detail.fetch("note-node").subjectRef).toBeNull();
  db.prepare("UPDATE people SET merged_into=NULL WHERE id='current-person'").run();
  db.prepare("DELETE FROM person_annotations WHERE id='note-owner'").run();
  expect(detail.fetch("note-node").subjectRef).toBeNull();
});

it("keeps person subject references behind the same Library and detail privacy fence", () => {
  personNote();
  db.prepare("INSERT INTO knowledge_node_tombstones(id,deleted_at) VALUES('note-node',2)").run();
  expect(readKnowledgeLibrary(db, { kind: "person_annotation" }).items).toEqual([]);
  expect(() => new KnowledgeQueryService(db).fetch("note-node")).toThrow("not found");
});

it("does not reveal a subject through an alias node when its canonical owner is privacy-hidden", () => {
  personNote();
  db.prepare("INSERT INTO knowledge_node_tombstones(id,deleted_at) VALUES('note-owner',2)").run();
  expect(new KnowledgeQueryService(db).fetch("note-node").subjectRef).toBeNull();
  expect(readKnowledgeLibrary(db, { kind: "person_annotation" }).items[0]?.subjectRef).toBeNull();
});

it("retains person identity for invalidated and superseded historical notes", () => {
  personNote();
  const detail = new KnowledgeQueryService(db);
  db.prepare(
    "UPDATE person_annotations SET invalidated_at=2,superseded_by='replacement-note' WHERE id='note-owner'",
  ).run();
  const subject = { kind: "person", id: "current-person", name: "Maya Reeves" };
  expect(detail.fetch("note-node").subjectRef).toEqual(subject);
  expect(readKnowledgeLibrary(db, { kind: "person_annotation" }).items[0]?.subjectRef).toEqual(
    subject,
  );
});

function documentNote() {
  createAnnotationStorageTables(db);
  db.exec(
    "ALTER TABLE documents ADD COLUMN title TEXT; ALTER TABLE documents ADD COLUMN source_id TEXT;",
  );
  db.prepare(
    "INSERT INTO documents(id,content,content_hash,title,source_id) VALUES('note-source','A long document','v1','Equipment guide','fixture:manuals')",
  ).run();
  db.prepare(
    "INSERT INTO doc_annotations(id,doc_id,claim_type,claim_text,evidence_doc_id,evidence_quote,confidence,created_by_run,created_at) VALUES('doc-owner','note-source','summary','Useful context','note-source','A long document',0.9,'fixture',1)",
  ).run();
  wiki("doc-note", "doc_annotation");
  db.prepare(
    "UPDATE knowledge_nodes SET owner_id='doc-owner',fields_json=? WHERE id='doc-note'",
  ).run(JSON.stringify({ subjectId: "wrong-document" }));
}
it("identifies the canonical document subject on cards and historical note details", () => {
  documentNote();
  const subject = {
    kind: "source",
    id: "note-source",
    title: "Equipment guide",
    sourceId: "fixture:manuals",
  };
  expect(readKnowledgeLibrary(db, { kind: "doc_annotation" }).items[0]?.subjectRef).toEqual(
    subject,
  );
  db.prepare(
    "UPDATE doc_annotations SET invalidated_at=2,superseded_by='new-note' WHERE id='doc-owner'",
  ).run();
  expect(new KnowledgeQueryService(db).fetch("doc-note").subjectRef).toEqual(subject);
  db.prepare("UPDATE documents SET title='Updated guide' WHERE id='note-source'").run();
  expect(new KnowledgeQueryService(db).fetch("doc-note").subjectRef).toMatchObject({
    title: "Updated guide",
  });
});
it.each(["missing", "purging", "source-removed"])(
  "hides document identity when the subject is %s",
  (state) => {
    documentNote();
    if (state === "missing") db.prepare("DELETE FROM documents WHERE id='note-source'").run();
    else if (state === "purging")
      db.exec(
        "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES('purge','source','note-source','v1',2)",
      );
    else
      db.exec(
        "CREATE TABLE removed_sources(id TEXT PRIMARY KEY); INSERT INTO removed_sources VALUES('fixture:manuals')",
      );
    expect(new KnowledgeQueryService(db).fetch("doc-note").subjectRef).toBeNull();
  },
);

it("preserves document identity after canonical withdrawal physically removes the owner, with current privacy fencing", () => {
  documentNote();
  db.prepare("DELETE FROM knowledge_nodes WHERE id='doc-note'").run();
  convertKnowledgeOwner(db, "doc_annotation", "doc-owner", 20);
  db.prepare("UPDATE knowledge_nodes SET fields_json=? WHERE id='doc-owner'").run(
    JSON.stringify({ subjectId: "wrong-document" }),
  );
  expect(withdrawKnowledgeOwner(db, "doc_annotation", "doc-owner", 30)).toBe(true);
  expect(db.prepare("SELECT id FROM doc_annotations WHERE id='doc-owner'").get()).toBeUndefined();
  const detail = new KnowledgeQueryService(db);
  const expected = {
    kind: "source",
    id: "note-source",
    title: "Equipment guide",
    sourceId: "fixture:manuals",
  };
  expect(detail.fetch("doc-owner").canonicalFields).toMatchObject({
    withdrawn: true,
    withdrawnAt: 30,
    subjectId: "note-source",
  });
  expect(detail.fetch("doc-owner").subjectRef).toEqual(expected);
  expect(
    readKnowledgeLibrary(db, { kind: "doc_annotation" }).items.find(
      (node) => node.id === "doc-owner",
    )?.subjectRef,
  ).toEqual(expected);
  db.prepare("UPDATE documents SET title='Current source title' WHERE id='note-source'").run();
  expect(detail.fetch("doc-owner").subjectRef).toMatchObject({ title: "Current source title" });
  db.exec(
    "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES('purge','source','note-source','v1',40)",
  );
  expect(readKnowledgeSubjectRef(db, "doc-owner", "doc_annotation")).toBeNull();
  expect(
    readKnowledgeLibrary(db, { kind: "doc_annotation" }).items.find(
      (node) => node.id === "doc-owner",
    ),
  ).toBeUndefined();
});

it("resolves an intentionally withdrawn person's authoritative subject through current merges and hides unavailable people", () => {
  personNote();
  db.prepare("INSERT INTO documents VALUES('evidence','Printed instructions','v1')").run();
  db.prepare("DELETE FROM knowledge_nodes WHERE id='note-node'").run();
  convertKnowledgeOwner(db, "person_annotation", "note-owner", 20);
  db.prepare("UPDATE knowledge_nodes SET fields_json=? WHERE id='note-owner'").run(
    JSON.stringify({ subjectId: "wrong-person", personName: "Stale name" }),
  );
  expect(withdrawKnowledgeOwner(db, "person_annotation", "note-owner", 30)).toBe(true);
  const detail = new KnowledgeQueryService(db);
  const expected = { kind: "person", id: "current-person", name: "Maya Reeves" };
  expect(detail.fetch("note-owner").subjectRef).toEqual(expected);
  expect(
    readKnowledgeLibrary(db, { kind: "person_annotation" }).items.find(
      (node) => node.id === "note-owner",
    )?.subjectRef,
  ).toEqual(expected);
  db.prepare("UPDATE people SET canonical_name='Maya R.' WHERE id='current-person'").run();
  expect(detail.fetch("note-owner").subjectRef).toMatchObject({ name: "Maya R." });
  db.prepare("DELETE FROM people WHERE id='current-person'").run();
  expect(detail.fetch("note-owner").subjectRef).toBeNull();
  db.prepare("INSERT INTO knowledge_node_tombstones VALUES('note-owner',40)").run();
  expect(readKnowledgeSubjectRef(db, "note-owner", "person_annotation")).toBeNull();
});

it.each([
  { subjectId: "note-source" },
  { withdrawn: true, subjectId: "note-source" },
  { withdrawn: "true", withdrawnAt: 30, subjectId: "note-source" },
  { withdrawn: true, withdrawnAt: -1, subjectId: "note-source" },
])(
  "does not treat an arbitrary missing owner's fields as an intentional withdrawal: %j",
  (fields) => {
    documentNote();
    db.prepare("DELETE FROM doc_annotations WHERE id='doc-owner'").run();
    db.prepare("UPDATE knowledge_nodes SET id='doc-owner',fields_json=? WHERE id='doc-note'").run(
      JSON.stringify(fields),
    );
    expect(new KnowledgeQueryService(db).fetch("doc-owner").subjectRef).toBeNull();
  },
);

it("continues opt-in live paging while unrelated brain writes invalidate default strict cursors", () => {
  for (let i = 0; i < 6; i++) wiki(`page-${i}`);
  const firstLive = readKnowledgeLibrary(db, { consistency: "live", kind: "wiki", limit: 2 });
  const firstStrict = readKnowledgeLibrary(db, { kind: "wiki", limit: 2 });
  const ids = firstLive.items.map((item) => item.id);
  let cursor = firstLive.pageInfo.nextCursor;
  while (cursor) {
    db.prepare(
      "UPDATE knowledge_nodes SET title=title||'.',updated_at=updated_at+1 WHERE id='page-5'",
    ).run();
    const next = readKnowledgeLibrary(db, { consistency: "live", kind: "wiki", limit: 2, cursor });
    expect(next.pageInfo.consistency).toBe("live");
    ids.push(...next.items.map((item) => item.id));
    cursor = next.pageInfo.nextCursor;
  }
  expect(ids).toEqual(["page-5", "page-4", "page-3", "page-2", "page-1", "page-0"]);
  expect(new Set(ids).size).toBe(ids.length);
  expect(() =>
    readKnowledgeLibrary(db, { kind: "wiki", cursor: firstStrict.pageInfo.nextCursor! }),
  ).toThrow("list changed");
  expect(() =>
    readKnowledgeLibrary(db, { kind: "wiki", cursor: firstLive.pageInfo.nextCursor! }),
  ).toThrow("Invalid pagination cursor");
  expect(() =>
    readKnowledgeLibrary(db, {
      consistency: "live",
      kind: "loop",
      cursor: firstLive.pageInfo.nextCursor!,
    }),
  ).toThrow("Invalid pagination cursor");
});

it("live pages use current privacy fences and refresh reveals records moved above their anchor", () => {
  wiki("page-c");
  wiki("page-b");
  wiki("page-a");
  const first = readKnowledgeLibrary(db, { consistency: "live", kind: "wiki", limit: 1 });
  expect(first.items[0]!.id).toBe("page-c");
  db.prepare("UPDATE knowledge_nodes SET updated_at=100 WHERE id='page-b'").run();
  db.prepare("INSERT INTO knowledge_node_tombstones(id,deleted_at) VALUES('page-a',50)").run();
  const next = readKnowledgeLibrary(db, {
    consistency: "live",
    kind: "wiki",
    cursor: first.pageInfo.nextCursor!,
  });
  expect(next.items).toEqual([]);
  expect(next.pageInfo.hasMore).toBe(false);
  const refresh = readKnowledgeLibrary(db, { consistency: "live", kind: "wiki" });
  expect(refresh.items.map((item) => item.id)).toEqual(["page-b", "page-c"]);
});
