// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, it } from "vitest";
import {
  createKnowledgeTables,
  saveKnowledgeNode,
  getKnowledgeNode,
  recordKnowledgeSourceChange,
} from "./storage.js";
import { readKnowledgeSourceRevision } from "./source-revision.js";
import { CONTEXTUAL_VERIFIER } from "./claim-context.js";
import { KnowledgeReferenceReader, selectedReferenceAuthority } from "./reference-reader.js";
import {
  captureKnowledgeRootContext,
  isCapturedKnowledgeRootSupportCurrent,
} from "./root-context.js";
import type { SaveKnowledgeNodeInput } from "./types.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT)");
  db.prepare("INSERT INTO documents VALUES(?,?,?)").run("record", "The prism has six faces.", "v1");
  db.prepare("INSERT INTO documents VALUES(?,?,?)").run("other", "The stand is blue.", "v1");
  createKnowledgeTables(db);
  save();
});
afterEach(() => db.close());
function save(overrides: Partial<SaveKnowledgeNodeInput> = {}) {
  const id = overrides.id ?? "orientation";
  const result = saveKnowledgeNode(
    db,
    {
      id,
      kind: "root",
      title: "Optics notes",
      markdown: '<claim id="shape" refs="source:record">The prism has six faces.</claim>',
      expectedRevision: getKnowledgeNode(db, id)?.revision ?? 0,
      inputVersions: { "source:record": "v1" },
      ...overrides,
    },
    10,
  );
  db.prepare("UPDATE knowledge_claims SET verification='verified',verifier=? WHERE node_id=?").run(
    CONTEXTUAL_VERIFIER,
    id,
  );
  return result;
}

it("preserves captured support across physical revision and unrelated navigation/sibling edits", () => {
  const captured = captureKnowledgeRootContext(db);
  expect(captured.support).toHaveLength(1);
  expect(isCapturedKnowledgeRootSupportCurrent(db, captured)).toBe(true);
  save();
  expect(captureKnowledgeRootContext(db).text).not.toBe(captured.text);
  expect(isCapturedKnowledgeRootSupportCurrent(db, captured)).toBe(true);
  save({
    markdown:
      '<claim id="shape" refs="source:record">The prism has six faces.</claim>\n\n[Unverified catalogue](wiki:catalogue)\n\n<claim id="colour" refs="source:other">The stand is blue.</claim>',
    inputVersions: { "source:record": "v1", "source:other": "v1" },
  });
  db.exec("UPDATE knowledge_claims SET verification='unverified' WHERE id='colour'");
  expect(isCapturedKnowledgeRootSupportCurrent(db, captured)).toBe(true);
  db.exec("UPDATE documents SET content_hash='v2' WHERE id='other'");
  expect(isCapturedKnowledgeRootSupportCurrent(db, captured)).toBe(true);
  // Privacy remains whole-root, including the unrelated sibling's ancestry.
  db.exec(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('other','v2',1,20)",
  );
  db.exec("DELETE FROM documents WHERE id='other'");
  expect(isCapturedKnowledgeRootSupportCurrent(db, captured)).toBe(false);
});

it("revalidates captured refs even when a later presentation budget omits them", () => {
  const captured = captureKnowledgeRootContext(db);
  save({
    markdown:
      '<claim id="shape" refs="source:record">The prism has six faces.</claim>\n\n' +
      "Unverified orientation. ".repeat(100),
  });
  expect(captureKnowledgeRootContext(db, captured.text.length).support).toHaveLength(0);
  expect(isCapturedKnowledgeRootSupportCurrent(db, captured)).toBe(true);
});

it.each([
  "UPDATE knowledge_claims SET verification='unverified' WHERE id='shape'",
  "UPDATE knowledge_claims SET verifier='obsolete-policy' WHERE id='shape'",
  "UPDATE knowledge_claims SET fingerprint='different-proof' WHERE id='shape'",
  "UPDATE knowledge_claims SET witness_refs_json='[\"source:other\"]' WHERE id='shape'",
  "UPDATE documents SET content_hash='v2' WHERE id='record'",
  "DELETE FROM documents WHERE id='record'",
  "UPDATE knowledge_nodes SET fields_json='{\"withdrawn\":true}' WHERE id='orientation'",
  "UPDATE knowledge_nodes SET owner_id='different-owner' WHERE id='orientation'",
  "UPDATE knowledge_nodes SET created_at=11 WHERE id='orientation'",
  "DELETE FROM knowledge_nodes WHERE id='orientation'",
])("refuses a changed captured proof/identity/privacy: %s", (sql) => {
  const captured = captureKnowledgeRootContext(db);
  db.exec(sql);
  expect(isCapturedKnowledgeRootSupportCurrent(db, captured)).toBe(false);
});

it.each([
  { title: "Proposed optics notes" },
  {
    markdown:
      '# Proposed shape\n<claim id="shape" refs="source:record">The prism has six faces.</claim>',
  },
  { claims: [{ id: "shape", modality: "proposal" as const }] },
])("refuses changed placement or semantics despite unchanged inner words", (change) => {
  const captured = captureKnowledgeRootContext(db);
  save(change);
  expect(isCapturedKnowledgeRootSupportCurrent(db, captured)).toBe(false);
});

it("refuses same-meaning source reproof and never exposes authority hashes in JSON", () => {
  const captured = captureKnowledgeRootContext(db);
  const prior = captured.support[0]!;
  expect(prior[selectedReferenceAuthority]).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(captured.support)).not.toContain(prior[selectedReferenceAuthority]);
  db.exec(
    "UPDATE documents SET content_hash='v2',content='The prism has six faces. Calibration recorded.' WHERE id='record'",
  );
  save({ inputVersions: { "source:record": "v2" } });
  const after = captureKnowledgeRootContext(db);
  expect(after.support[0]!.revision).toBe(prior.revision);
  expect(after.support[0]!.text).toBe(prior.text);
  expect(isCapturedKnowledgeRootSupportCurrent(db, after)).toBe(true);
  expect(isCapturedKnowledgeRootSupportCurrent(db, captured)).toBe(false);
});

it("binds nested support proof even when the root dependency semantic revision stays unchanged", () => {
  save({ id: "detail", kind: "wiki" });
  save({
    markdown: '<claim id="shape" refs="wiki:detail#claim:shape">The prism has six faces.</claim>',
    inputVersions: { "wiki:detail#claim:shape": 1 },
  });
  const captured = captureKnowledgeRootContext(db);
  expect(captured.support).toHaveLength(1);
  db.exec("UPDATE documents SET content_hash='v2' WHERE id='record'");
  save({ id: "detail", kind: "wiki", inputVersions: { "source:record": "v2" } });
  const now = captureKnowledgeRootContext(db);
  expect(now.support[0]!.text).toBe(captured.support[0]!.text);
  expect(now.support[0]!.revision).toBe(captured.support[0]!.revision);
  expect(isCapturedKnowledgeRootSupportCurrent(db, now)).toBe(true);
  expect(isCapturedKnowledgeRootSupportCurrent(db, captured)).toBe(false);
});

it("retains existing verified field support without granting new authority", () => {
  save({ id: "detail", kind: "loop", canonicalFields: { colour: "blue" } });
  save({
    markdown:
      '<claim id="shape" refs="loop:detail#field:colour">The stored colour is blue.</claim>',
    inputVersions: { "loop:detail#field:colour": 1 },
  });
  const captured = captureKnowledgeRootContext(db);
  expect(captured.support).toHaveLength(1);
  expect(isCapturedKnowledgeRootSupportCurrent(db, captured)).toBe(true);
  save({ id: "detail", kind: "loop", canonicalFields: { colour: "green" } });
  expect(isCapturedKnowledgeRootSupportCurrent(db, captured)).toBe(false);
});

it("requires every captured fact but never imports new facts", () => {
  save({
    markdown:
      '<claim id="shape" refs="source:record">The prism has six faces.</claim>\n<claim id="colour" refs="source:other">The stand is blue.</claim>',
    inputVersions: { "source:record": "v1", "source:other": "v1" },
  });
  const captured = captureKnowledgeRootContext(db);
  expect(captured.support).toHaveLength(2);
  db.exec("UPDATE knowledge_claims SET verification='unverified' WHERE id='colour'");
  expect(isCapturedKnowledgeRootSupportCurrent(db, captured)).toBe(false);
  expect(captured.support).toHaveLength(2);
});

it("keeps ordinary reader serialization unchanged and empty support independent of orientation", () => {
  const plain = new KnowledgeReferenceReader(db).reference("wiki:orientation#claim:shape");
  const bound = new KnowledgeReferenceReader(db, true).reference("wiki:orientation#claim:shape");
  expect(plain[selectedReferenceAuthority]).toBeUndefined();
  expect(JSON.stringify(bound)).toBe(JSON.stringify(plain));
  expect(isCapturedKnowledgeRootSupportCurrent(db, { text: "", support: [] })).toBe(true);
});

it("binds enclosing parent proof independently of the child's unchanged statement", () => {
  save({
    markdown:
      '<claim id="parent" refs="source:record">Prism description: <claim id="shape" refs="source:record">The prism has six faces.</claim></claim>',
  });
  const captured = captureKnowledgeRootContext(db);
  const child = captured.support.find((value) => value.ref.endsWith("#claim:shape"))!;
  const childOnly = { ...captured, support: [child] };
  expect(isCapturedKnowledgeRootSupportCurrent(db, childOnly)).toBe(true);
  db.exec("UPDATE knowledge_claims SET fingerprint='changed-parent-proof' WHERE id='parent'");
  expect(isCapturedKnowledgeRootSupportCurrent(db, childOnly)).toBe(false);
});

it("refuses malformed or oversized private selections rather than substituting current facts", () => {
  const captured = captureKnowledgeRootContext(db);
  expect(
    isCapturedKnowledgeRootSupportCurrent(db, {
      ...captured,
      support: Array.from({ length: 17 }, () => captured.support[0]!),
    }),
  ).toBe(false);
  expect(
    isCapturedKnowledgeRootSupportCurrent(db, {
      ...captured,
      support: [{ ...captured.support[0]!, ref: "wiki:different#claim:shape" }],
    }),
  ).toBe(false);
});

it("refuses original-source ABA after same-byte restoration and successful reproof", () => {
  recordKnowledgeSourceChange(db, { documentId: "record", contentHash: "v1" }, 11);
  save({ inputVersions: { "source:record": readKnowledgeSourceRevision(db, "record")! } });
  const captured = captureKnowledgeRootContext(db);
  db.exec(
    "UPDATE documents SET content='Alternate description.',content_hash='v2' WHERE id='record'",
  );
  recordKnowledgeSourceChange(db, { documentId: "record", contentHash: "v2" }, 12);
  db.exec(
    "UPDATE documents SET content='The prism has six faces.',content_hash='v1' WHERE id='record'",
  );
  recordKnowledgeSourceChange(db, { documentId: "record", contentHash: "v1" }, 13);
  save({ inputVersions: { "source:record": readKnowledgeSourceRevision(db, "record")! } });
  const after = captureKnowledgeRootContext(db);
  expect(after.support[0]!.text).toBe(captured.support[0]!.text);
  expect(after.support[0]!.revision).toBe(captured.support[0]!.revision);
  expect(isCapturedKnowledgeRootSupportCurrent(db, after)).toBe(true);
  expect(isCapturedKnowledgeRootSupportCurrent(db, captured)).toBe(false);
});

it("preserves historical privacy when an unrelated dependency was removed before capture", () => {
  save({
    markdown:
      '<claim id="shape" refs="source:record">The prism has six faces.</claim>\n<claim id="colour" refs="source:other">The stand is blue.</claim>',
    inputVersions: { "source:record": "v1", "source:other": "v1" },
  });
  save();
  const captured = captureKnowledgeRootContext(db);
  expect(isCapturedKnowledgeRootSupportCurrent(db, captured)).toBe(true);
  db.exec(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('other','v1',1,20)",
  );
  expect(isCapturedKnowledgeRootSupportCurrent(db, captured)).toBe(false);
});
