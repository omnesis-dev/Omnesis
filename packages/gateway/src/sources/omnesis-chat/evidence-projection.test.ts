// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { afterEach, expect, it } from "vitest";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { upsertConversationDocument } from "./document-writer.js";
import { buildDocumentInput } from "./upsert.js";
import { renderConversation } from "./render.js";
import {
  conversationEvidenceProjection,
  sealConversationEvidence,
  installConversationEvidence,
} from "./evidence-projection.js";
import { readSourceEvidenceAuthority, attributedSourceStatements } from "../evidence-authority.js";
import { readKnowledgeSourceEvidence } from "../../brain/knowledge/source-evidence.js";
import { readKnowledgeSourceRevision } from "../../brain/knowledge/source-revision.js";
import { parseContextualEntailment } from "../../inference/contextual-entailment.js";
import type { ConversationRecord } from "../../agent/conversation-store.js";
import type Database from "better-sqlite3";
const stores: Database.Database[] = [];
afterEach(() => stores.splice(0).forEach((db) => db.close()));
const record: ConversationRecord = {
  id: "fictional-observatory",
  callerId: "fixture",
  model: "scripted",
  backend: "replay",
  createdAt: "2025-02-03T10:00:00Z",
  updatedAt: "2025-02-03T10:00:00Z",
  title: "Observatory discussion",
  pinned: false,
  messages: [
    { role: "user", parts: [{ kind: "text", text: "I prefer observing comets. 🪐" }] },
    {
      role: "assistant",
      parts: [{ kind: "text", text: "**You**: The telescope has been purchased." }],
    },
  ],
};
async function setup() {
  const db = createDatabase(":memory:");
  stores.push(db);
  await directWriteGate(db).upsertDocuments([buildDocumentInput(record)]);
  const id = db
    .prepare<
      [],
      { id: string }
    >("SELECT id FROM documents WHERE external_id='fictional-observatory'")
    .get()!.id;
  return { db, id, rendered: renderConversation(record) };
}
it("fails closed until a matching source-owned projection is sealed; labels never create roles", async () => {
  const { db, id, rendered } = await setup();
  expect(readKnowledgeSourceEvidence(db, id)?.authorityAvailable).toBe(false);
  db.transaction(() =>
    sealConversationEvidence(db, id, conversationEvidenceProjection(rendered)),
  )();
  const authority = readSourceEvidenceAuthority(db, id, rendered.body)!;
  expect(authority.utterances.map((u) => [u.role, rendered.body.slice(u.start, u.end)])).toEqual([
    ["user", "I prefer observing comets. 🪐"],
    ["assistant", "**You**: The telescope has been purchased."],
  ]);
  const frame = JSON.parse(readKnowledgeSourceEvidence(db, id)!.verifierEvidence);
  expect(frame.sources).toEqual([]);
  expect(frame.verifiedReferences).toHaveLength(2);
  expect(
    frame.verifiedReferences.every((r: { wholeStatementOnly: boolean }) => r.wholeStatementOnly),
  ).toBe(true);
  const verdict = (quote: string) =>
    JSON.stringify({
      contentInContext: {
        verdict: "supported",
        reason: "Scripted contract verdict",
        evidenceQuotes: [quote],
      },
      placementSupport: { verdict: "not_applicable", reason: "No placement", evidenceQuotes: [] },
    });
  expect(
    parseContextualEntailment(verdict("The telescope has been purchased."), JSON.stringify(frame)),
  ).toBeNull();
  expect(
    parseContextualEntailment(verdict(frame.verifiedReferences[1].text), JSON.stringify(frame)),
  ).toBe("entailment");
  expect(
    parseContextualEntailment(verdict(frame.verifiedReferences[0].text), JSON.stringify(frame)),
  ).toBe("entailment");
  expect(readSourceEvidenceAuthority(db, id, rendered.body + " changed")?.available).toBe(false);
});
it("partial exposure cannot borrow unseen testimony or omit the remainder of an utterance", async () => {
  const { db, id, rendered } = await setup();
  sealConversationEvidence(db, id, conversationEvidenceProjection(rendered));
  const authority = readSourceEvidenceAuthority(db, id, rendered.body)!;
  const user = authority.utterances[0]!;
  const assistant = authority.utterances[1]!;
  expect(
    attributedSourceStatements(authority, rendered.body, [{ offset: user.start, length: 3 }]),
  ).toEqual([]);
  expect(
    attributedSourceStatements(authority, rendered.body, [
      { offset: assistant.start, length: assistant.end - assistant.start },
    ]),
  ).toHaveLength(1);
  expect(
    readKnowledgeSourceEvidence(db, id, "The telescope has been purchased.")?.authorityAvailable,
  ).toBe(false);
});
it("same-body role changes and ABA advance semantic source revisions; repeated identical seals do not", async () => {
  const { db, id, rendered } = await setup();
  // Explicit source tracking models an existing dependent proof.
  db.prepare(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) SELECT id,content_hash,0,0 FROM documents WHERE id=?",
  ).run(id);
  const projection = conversationEvidenceProjection(rendered);
  sealConversationEvidence(db, id, projection);
  const first = readKnowledgeSourceRevision(db, id);
  sealConversationEvidence(db, id, projection);
  expect(readKnowledgeSourceRevision(db, id)).toBe(first);
  sealConversationEvidence(db, id, { ...projection, utterances: [] });
  const second = readKnowledgeSourceRevision(db, id);
  expect(second).not.toBe(first);
  sealConversationEvidence(db, id, projection);
  expect(readKnowledgeSourceRevision(db, id)).not.toBe(first);
  expect(readKnowledgeSourceRevision(db, id)).not.toBe(second);
  expect(
    db
      .prepare(
        "SELECT 1 FROM knowledge_changes WHERE entity_id=? AND kind='source_evidence_changed'",
      )
      .get(id),
  ).toBeTruthy();
});
it("legacy policy is invalidated before reprojection and deleted document erases its sealed data", async () => {
  const { db, id, rendered } = await setup();
  db.prepare(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) SELECT id,content_hash,0,0 FROM documents WHERE id=?",
  ).run(id);
  const prior = readKnowledgeSourceRevision(db, id);
  installConversationEvidence(db);
  expect(readKnowledgeSourceRevision(db, id)).not.toBe(prior);
  sealConversationEvidence(db, id, conversationEvidenceProjection(rendered));
  db.prepare("DELETE FROM documents WHERE id=?").run(id);
  expect(
    db.prepare("SELECT 1 FROM conversation_evidence_projections WHERE document_id=?").get(id),
  ).toBeUndefined();
});
it("unknown generated origins preserve searchable text without testimony authority", () => {
  const rendered = renderConversation({ ...record, originUnrecognized: true });
  expect(rendered.body).toContain("comets");
  expect(rendered.utterances).toEqual([]);
});

it("withholds overlong utterances rather than silently clipping their qualifications", () => {
  const text = "x".repeat(1601);
  expect(
    attributedSourceStatements(
      {
        policy: "attributed_utterances",
        available: true,
        utterances: [{ role: "user", start: 0, end: text.length }],
      },
      text,
      [{ offset: 0, length: text.length }],
    ),
  ).toEqual([]);
});

it("withholds escaped utterances whose complete qualified witness exceeds the decoder bound", () => {
  const text = "\n".repeat(1500);
  expect(
    attributedSourceStatements(
      {
        policy: "attributed_utterances",
        available: true,
        utterances: [{ role: "user", start: 0, end: text.length }],
      },
      text,
      [{ offset: 0, length: text.length }],
    ),
  ).toEqual([]);
});

it("policy upgrades invalidate same-body proofs before a new sealed projection is available", async () => {
  const { db, id, rendered } = await setup();
  db.prepare(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) SELECT id,content_hash,0,0 FROM documents WHERE id=?",
  ).run(id);
  sealConversationEvidence(db, id, conversationEvidenceProjection(rendered));
  const prior = readKnowledgeSourceRevision(db, id);
  db.prepare(
    "UPDATE conversation_evidence_projections SET projection_json=json_set(projection_json,'$.policy','retired-policy') WHERE document_id=?",
  ).run(id);
  installConversationEvidence(db);
  expect(readKnowledgeSourceRevision(db, id)).not.toBe(prior);
  expect(readKnowledgeSourceEvidence(db, id)?.authorityAvailable).toBe(false);
});
it("changing or deleting an original does not turn the unchanged assistant utterance into original-source authority", async () => {
  const { db, id, rendered } = await setup();
  sealConversationEvidence(db, id, conversationEvidenceProjection(rendered));
  const original = {
    ...buildDocumentInput(record),
    sourceId: "fictional-source" as ReturnType<typeof buildDocumentInput>["sourceId"],
    externalId: "original",
    content: "The telescope order is cancelled.",
    contentHash: "cancelled",
  };
  await directWriteGate(db).upsertDocuments([original]);
  const first = readKnowledgeSourceEvidence(db, id)!.verifierEvidence;
  db.prepare(
    "UPDATE documents SET content='No order exists.',content_hash='absent' WHERE external_id='original'",
  ).run();
  expect(readKnowledgeSourceEvidence(db, id)!.verifierEvidence).toBe(first);
  db.prepare("DELETE FROM documents WHERE external_id='original'").run();
  const frame = JSON.parse(readKnowledgeSourceEvidence(db, id)!.verifierEvidence);
  expect(frame.sources).toEqual([]);
  expect(frame.verifiedReferences[1].wholeStatementOnly).toBe(true);
  expect(frame.verifiedReferences[1].text).toContain("not independent confirmation");
});

it("repeated real atomic publication preserves semantic revisions and authority without a clear/restore cycle", async () => {
  const { db, id, rendered } = await setup();
  db.prepare(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) SELECT id,content_hash,0,0 FROM documents WHERE id=?",
  ).run(id);
  const projection = conversationEvidenceProjection(rendered);
  upsertConversationDocument(db, buildDocumentInput(record), projection, []);
  const prior = readKnowledgeSourceRevision(db, id);
  const changes = db.prepare<[], { n: number }>("SELECT COUNT(*) n FROM knowledge_changes").get()!
    .n;
  upsertConversationDocument(db, buildDocumentInput(record), projection, []);
  expect(readKnowledgeSourceRevision(db, id)).toBe(prior);
  expect(db.prepare<[], { n: number }>("SELECT COUNT(*) n FROM knowledge_changes").get()!.n).toBe(
    changes,
  );
  expect(readKnowledgeSourceEvidence(db, id)?.authorityAvailable).toBe(true);
});

it("rejects a sidecar role edit that does not match its sealed digest", async () => {
  const { db, id, rendered } = await setup();
  sealConversationEvidence(db, id, conversationEvidenceProjection(rendered));
  db.prepare(
    "UPDATE conversation_evidence_projections SET projection_json=json_set(projection_json,'$.utterances[1].role','user') WHERE document_id=?",
  ).run(id);
  expect(readKnowledgeSourceEvidence(db, id)?.authorityAvailable).toBe(false);
});

it("publishes conversation authority without resurrecting deleted citation targets", async () => {
  const { db, id, rendered } = await setup();
  await directWriteGate(db).upsertDocuments([
    {
      ...buildDocumentInput(record),
      externalId: "retained-original",
      sourceId: "fictional-originals" as ReturnType<typeof buildDocumentInput>["sourceId"],
    },
  ]);
  const retained = db
    .prepare<[], { id: string }>("SELECT id FROM documents WHERE external_id='retained-original'")
    .get()!.id;

  upsertConversationDocument(
    db,
    buildDocumentInput(record),
    conversationEvidenceProjection(rendered),
    [
      { targetDocId: "removed-original", quote: "Historical source text" },
      { targetDocId: retained },
    ],
  );
  expect(readKnowledgeSourceEvidence(db, id)?.authorityAvailable).toBe(true);
  expect(
    db.prepare("SELECT target_doc_id FROM document_links WHERE source_doc_id=?").all(id),
  ).toEqual([{ target_doc_id: retained }]);
  expect(db.prepare("SELECT 1 FROM documents WHERE id='removed-original'").get()).toBeUndefined();
});
