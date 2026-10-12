// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { createPersonAnnotation, getPersonAnnotation } from "../storage/person-annotations.js";
import { buildAnnotationTools, type AnnotationToolDeps } from "./tools.js";
import type { CheckRecord } from "../record-check/check.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let path: string;
const NOW = Date.parse("2026-06-01T12:00:00Z");
const CTX = { sessionId: "profile", messageId: "reconcile" };
const role = "Maya coordinates the observatory outreach team.";
const preference = "Maya prefers written questions before demonstrations.";
beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
  db.prepare(
    `INSERT INTO people(id,canonical_name,source,first_seen,last_seen,created_at,updated_at)
    VALUES('person','Maya Reeves','test',?,?,?,?)`,
  ).run(NOW, NOW, NOW, NOW);
  for (const [id, text] of [
    ["role-source", role],
    ["preference-source", preference],
  ]) {
    db.prepare(
      `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,
      source_created_at,source_updated_at,ingested_at,updated_at) VALUES(?,'test','test',?,?,?, ?,?,?,?,?)`,
    ).run(id, id, id, text, `hash-${id}`, NOW, NOW, NOW, NOW);
  }
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
});
function proposal() {
  return {
    personId: "person",
    claimType: "role",
    claimText: role,
    evidenceDocId: "role-source",
    evidenceQuote: role,
    confidence: 0.8,
    claimBasis: "quoted" as const,
  };
}
function seed(id = "prior", text = role, source = "role-source", type = "role") {
  return createPersonAnnotation(
    db,
    {
      ...proposal(),
      id,
      claimType: type,
      claimText: text,
      evidenceDocId: source,
      evidenceQuote: text,
      createdByRun: "seed",
      verificationState: "verified",
      lastVerifiedAt: NOW,
    },
    NOW,
  );
}
function harness(
  checkRecord: CheckRecord = async () => ({ save: true }),
  extra: Partial<AnnotationToolDeps> = {},
) {
  const verify = vi.fn(async (_input: { claim: string; evidence: string }) => ({
    label: "entailment" as const,
    probability: 1,
  }));
  const tools = buildAnnotationTools({
    db,
    writeGate: directWriteGate(db),
    clock: () => NOW + 1000,
    runId: "reconcile",
    log: createLogger("test:person-reconcile"),
    checkRecord,
    getEntailmentVerifier: async () => ({ verify, dispose: () => {} }),
    ...extra,
  });
  const invoke = (name: string, args: unknown) =>
    tools.find((t) => t.name === name)!.invoke(args, CTX);
  return { invoke, verify, read: () => invoke("annotation_search", { personId: "person" }) };
}

it("judges replacement against predecessors and retained final-profile context without losing the old record on refusal", async () => {
  seed();
  seed("retained", preference, "preference-source", "preference");
  db.prepare(
    `INSERT INTO knowledge_nodes(id,kind,owner_id,title,markdown,plain_text,
    revision,meaning_revision,meaning_hash,validity,metadata_json,fields_json,created_at,updated_at)
    VALUES('prior','person_annotation','prior','Role','','',1,1,'hash','current','{}','{}',?,?)`,
  ).run(NOW, NOW);
  const check = vi.fn<CheckRecord>(async () => ({
    save: false,
    decisionId: "decline",
    score: 0,
    threshold: 0.81,
  }));
  const h = harness(check);
  await h.read();
  const result = await h.invoke("annotate_person", {
    ...proposal(),
    claimText: "Maya coordinates outreach.",
    supersedes: "prior",
    reconciliationReason: "Shorten the role wording; retain the separate communication preference.",
  });
  expect(result).toMatchObject({ kind: "structured", resultType: "record.not_saved" });
  expect(check).toHaveBeenCalledTimes(1);
  const input = check.mock.calls[0]![0];
  expect(input.personContext?.reconciliation).toMatchObject({
    operation: "replace",
    truncated: false,
    predecessors: [{ id: "prior", text: role }],
    retained_profile: [{ id: "retained", text: preference }],
  });
  expect(input.payloadCapture?.subjects).toEqual(
    expect.arrayContaining([
      { kind: "source", id: "role-source" },
      { kind: "source", id: "preference-source" },
      { kind: "node", id: "prior" },
    ]),
  );
  expect(getPersonAnnotation(db, "prior")?.invalidatedAt).toBeNull();
  expect(db.prepare("SELECT COUNT(*) AS n FROM person_annotations").get()).toEqual({ n: 2 });
  expect(h.verify).not.toHaveBeenCalled();
});

it("routes meaningful revise through the same check and accepts an intentional editorial refinement", async () => {
  seed();
  const check = vi.fn<CheckRecord>(async () => ({ save: true }));
  const h = harness(check);
  await h.read();
  expect(
    await h.invoke("person_annotation_revise", {
      id: "prior",
      claimText: "Maya coordinates observatory outreach.",
      reconciliationReason: "Remove redundant team wording while retaining the scoped role.",
    }),
  ).toMatchObject({ resultType: "person_annotation.revised" });
  expect(check.mock.calls[0]![0].personContext?.reconciliation).toMatchObject({
    operation: "revise",
    predecessors: [{ id: "prior", text: role }],
    retained_profile: [],
  });
  expect(getPersonAnnotation(db, "prior")?.claimText).toBe(
    "Maya coordinates observatory outreach.",
  );
});

it("suppresses exact verified replacement and revise with no inference or history churn", async () => {
  seed();
  const check = vi.fn<CheckRecord>(async () => ({ save: true }));
  const h = harness(check);
  await h.read();
  for (const [tool, args] of [
    ["annotate_person", { ...proposal(), supersedes: "prior" }],
    ["person_annotation_revise", { id: "prior", claimText: role }],
    ["person_annotation_revise", { id: "prior", claimText: role, confidence: 0.8 }],
  ] as const) {
    expect(await h.invoke(tool, args)).toMatchObject({
      resultType: "person_annotation.unchanged",
      data: { id: "prior", unchanged: true },
    });
  }
  expect(check).not.toHaveBeenCalled();
  expect(h.verify).not.toHaveBeenCalled();
  expect(getPersonAnnotation(db, "prior")).toMatchObject({ updatedAt: null, lastVerifiedAt: NOW });
  expect(db.prepare("SELECT COUNT(*) AS n FROM person_annotations").get()).toEqual({ n: 1 });
});

it("does not suppress confidence changes or verification of an unverified record", async () => {
  seed();
  const h = harness();
  await h.read();
  expect(
    await h.invoke("person_annotation_revise", { id: "prior", confidence: 0.6 }),
  ).toMatchObject({ resultType: "person_annotation.revised" });
  expect(getPersonAnnotation(db, "prior")?.confidence).toBe(0.6);
  db.prepare(
    "UPDATE person_annotations SET verification_state='unverified',last_verified_at=NULL WHERE id='prior'",
  ).run();
  await h.read();
  expect(
    await h.invoke("person_annotation_revise", { id: "prior", claimText: role }),
  ).toMatchObject({ resultType: "person_annotation.revised" });
  expect(h.verify).toHaveBeenCalledTimes(2);
});

it("never treats a stale profile, withdrawn source, or changed quote as an unchanged success", async () => {
  seed();
  const h = harness();
  await h.read();
  db.prepare("UPDATE person_annotations SET confidence=0.7 WHERE id='prior'").run();
  expect(
    await h.invoke("annotate_person", { ...proposal(), confidence: 0.7, supersedes: "prior" }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  await h.read();
  db.prepare(
    "UPDATE documents SET content='The previous role was withdrawn.',content_hash='changed' WHERE id='role-source'",
  ).run();
  expect(
    await h.invoke("annotate_person", { ...proposal(), confidence: 0.7, supersedes: "prior" }),
  ).toMatchObject({ kind: "error", code: "evidence_not_found" });
  db.prepare(
    "UPDATE knowledge_source_revisions SET deleted=1 WHERE document_id='role-source'",
  ).run();
  expect(
    await h.invoke("person_annotation_revise", { id: "prior", claimText: role }),
  ).toMatchObject({ kind: "error" });
  expect(h.verify).not.toHaveBeenCalled();
});

it("keeps the writer profile fence after an asynchronous reconciliation verdict", async () => {
  seed();
  const h = harness(async () => {
    db.prepare(
      "UPDATE person_annotations SET claim_text='A concurrently corrected role.' WHERE id='prior'",
    ).run();
    return { save: true };
  });
  await h.read();
  expect(
    await h.invoke("annotate_person", {
      ...proposal(),
      claimText: "Maya coordinates outreach.",
      supersedes: "prior",
    }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  expect(getPersonAnnotation(db, "prior")?.claimText).toBe("A concurrently corrected role.");
  expect(db.prepare("SELECT COUNT(*) AS n FROM person_annotations").get()).toEqual({ n: 1 });
});

it("withholds reconciliation context when a retained legacy fact has withdrawn source ancestry", async () => {
  seed();
  seed("private", preference, "preference-source", "preference");
  db.prepare(
    "UPDATE knowledge_source_revisions SET deleted=1 WHERE document_id='preference-source'",
  ).run();
  const check = vi.fn<CheckRecord>(async () => ({
    save: false,
    decisionId: "decline",
    score: 0,
    threshold: 0.81,
  }));
  const h = harness(check);
  await h.read();
  await h.invoke("annotate_person", {
    ...proposal(),
    claimText: "Maya coordinates outreach.",
    supersedes: "prior",
  });
  expect(JSON.stringify(check.mock.calls)).not.toContain(preference);
  expect(check.mock.calls[0]![0].personContext).toBeUndefined();
  expect(check.mock.calls[0]![0].payloadCapture).toBeUndefined();
});

it("rejects replacement when a source changes during judgment even if its quote survives", async () => {
  seed();
  const h = harness(async () => {
    db.prepare(
      "UPDATE documents SET content=?,content_hash='new-source-version' WHERE id='role-source'",
    ).run(`Withdrawn statement: ${role}`);
    return { save: true };
  });
  await h.read();
  expect(
    await h.invoke("annotate_person", {
      ...proposal(),
      claimText: "Maya coordinates outreach.",
      supersedes: "prior",
    }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  expect(getPersonAnnotation(db, "prior")?.invalidatedAt).toBeNull();
  expect(db.prepare("SELECT COUNT(*) AS n FROM person_annotations").get()).toEqual({ n: 1 });
});

it("withholds profile context when privacy capture becomes unavailable during source validation", async () => {
  seed();
  const check = vi.fn<CheckRecord>(async () => ({
    save: false,
    decisionId: "unavailable",
    score: 0,
    threshold: 0.81,
  }));
  const h = harness(check, {
    validateAnnotationEvidence: async () => {
      db.prepare("UPDATE knowledge_decision_privacy SET generation=generation+1 WHERE id=1").run();
      return null;
    },
  });
  await h.read();
  await h.invoke("annotate_person", {
    ...proposal(),
    claimText: "Maya coordinates outreach.",
    supersedes: "prior",
  });
  expect(check).toHaveBeenCalledTimes(1);
  expect(check.mock.calls[0]![0].personContext).toBeUndefined();
  expect(check.mock.calls[0]![0].payloadCapture).toBeUndefined();
  expect(getPersonAnnotation(db, "prior")?.invalidatedAt).toBeNull();
});

it("passes the source framing around selected person quotes to the entailment verifier", async () => {
  const source = `Draft role proposal, not an assigned responsibility.\n${role}\nAwaiting approval.`;
  db.prepare("UPDATE documents SET content=?,content_hash='draft' WHERE id='role-source'").run(
    source,
  );
  const h = harness();
  await h.read();
  expect(await h.invoke("annotate_person", proposal())).toMatchObject({
    resultType: "person_annotation.created",
  });
  expect(h.verify).toHaveBeenCalledTimes(1);
  expect(h.verify.mock.calls[0]?.[0]).toMatchObject({
    evidence: JSON.stringify({
      sources: [
        {
          authority: "selected_quote",
          title: null,
          text: source,
          selectedQuotes: [role],
          truncated: false,
        },
      ],
      verifiedReferences: [],
      limitation:
        "Selected quotes supply the asserted facts. Surrounding source text only qualifies their interpretation; omitted passages cannot establish absence.",
    }),
  });
});

it("treats confidence-only revision as explicit re-verification without a new value judgment", async () => {
  seed();
  const check = vi.fn<CheckRecord>(async () => ({ save: true }));
  const h = harness(check);
  await h.read();
  expect(
    await h.invoke("person_annotation_revise", { id: "prior", confidence: 0.8 }),
  ).toMatchObject({ resultType: "person_annotation.revised" });
  expect(h.verify).toHaveBeenCalledOnce();
  expect(check).not.toHaveBeenCalled();
  expect(getPersonAnnotation(db, "prior")).toMatchObject({
    claimText: role,
    confidence: 0.8,
    lastVerifiedAt: NOW + 1000,
  });
});

it("blocks destructive retract and pure supersede when useful meaning needs atomic replacement", async () => {
  seed();
  seed("retained", preference, "preference-source", "preference");
  const check = vi.fn<CheckRecord>(async (input) =>
    input.personWithdrawal
      ? {
          save: false,
          decisionId: "decline",
          score: 0,
          threshold: 1.5,
          questionId: "withdrawal_preservation",
        }
      : { save: true },
  );
  const h = harness(check);
  await h.read();
  expect(await h.invoke("person_annotation_retract", { id: "prior" })).toMatchObject({
    kind: "error",
    code: "person_withdrawal_refused",
  });
  expect(
    await h.invoke("person_annotation_supersede", { id: "prior", supersededBy: "retained" }),
  ).toMatchObject({ kind: "error", code: "person_withdrawal_refused" });
  expect(getPersonAnnotation(db, "prior")).not.toBeNull();
  expect(check.mock.calls[0]![0].personContext?.reconciliation).toMatchObject({
    operation: "withdraw",
    predecessors: [{ id: "prior" }],
    retained_profile: [{ id: "retained" }],
  });
  expect(
    await h.invoke("annotate_person", {
      ...proposal(),
      claimText: "Maya coordinates observatory outreach.",
      supersedes: ["prior"],
      reconciliationReason: "Preserve the role in an atomic replacement.",
    }),
  ).toMatchObject({ kind: "structured" });
  expect(getPersonAnnotation(db, "prior")?.invalidatedAt).not.toBeNull();
});

it.each(["person_annotation_retract", "person_annotation_supersede"])(
  "%s fences sibling changes after approval",
  async (name) => {
    seed();
    seed("retained", preference, "preference-source", "preference");
    const h = harness(async (input) => {
      if (input.personWithdrawal)
        db.prepare("UPDATE person_annotations SET claim_text=? WHERE id='retained'").run(
          "Maya now welcomes live questions.",
        );
      return { save: true };
    });
    await h.read();
    await expect(
      h.invoke(name, {
        id: "prior",
        ...(name.endsWith("supersede") ? { supersededBy: "retained" } : {}),
      }),
    ).rejects.toThrow("Person profile changed");
    expect(getPersonAnnotation(db, "prior")?.invalidatedAt).toBeNull();
  },
);

it("withdrawal fences a source metadata ABA while the judgment is pending", async () => {
  seed();
  const h = harness(async (input) => {
    if (input.personWithdrawal) {
      const title = (
        db.prepare("SELECT title FROM documents WHERE id='role-source'").get() as { title: string }
      ).title;
      db.prepare("UPDATE documents SET title=? WHERE id='role-source'").run("Reinterpreted source");
      db.prepare("UPDATE documents SET title=? WHERE id='role-source'").run(title);
    }
    return { save: true };
  });
  await h.read();
  await expect(h.invoke("person_annotation_retract", { id: "prior" })).rejects.toThrow(
    "Person profile changed",
  );
  expect(getPersonAnnotation(db, "prior")?.invalidatedAt).toBeNull();
});

it("permits judged redundant withdrawal while preserving its existing replacement", async () => {
  seed();
  seed("replacement", role, "role-source", "coordination");
  const h = harness(async () => ({ save: true }));
  await h.read();
  expect(
    await h.invoke("person_annotation_supersede", { id: "prior", supersededBy: "replacement" }),
  ).toMatchObject({ kind: "structured", resultType: "person_annotation.superseded" });
  expect(getPersonAnnotation(db, "replacement")?.invalidatedAt).toBeNull();
});
