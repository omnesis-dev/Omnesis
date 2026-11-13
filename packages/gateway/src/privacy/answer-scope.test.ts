// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { encodeStoredScopePolicies } from "../access/scope-policy-encoding.js";
import { directWriteGate } from "../write-gate.js";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { LEDGER_PROFILE, publishProfile } from "../access/filter-test-utils.js";
import {
  createCorpusAuthorization,
  serializeCorpusAuthorization,
  externalAnswerOwnerId,
} from "../access/corpus-authorization.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { directReadPort } from "../scheduler/read-port.js";
import {
  beginAnswerTask,
  completeAnswerTask,
  getAnswerTaskResponse,
  loadReleasedAnswerHistory,
  resolvePrivacyApproval,
  digestCandidate,
  loadPrivacyReviewerContext,
  recordAnswerEgress,
} from "./store.js";
import {
  createAnswerScopeReadObserver,
  createScopeReleaseCapture,
  MAX_ANSWER_SCOPE_DOCUMENTS,
  assertAnswerTaskScopeCurrent,
  assertAnswerTaskReleaseCurrent,
  assertAnswerRunScopeCurrent,
} from "./answer-scope.js";
import { commitPrivacyPolicy } from "./policy-history.js";
import { AnswerService, type AnswerCandidateGenerator } from "./answer-service.js";
import { ANSWER_HISTORY_READS } from "./context-reads.js";
import { authorizeAnswerCompletionDelivery } from "./completion-delivery-store.js";
import type { PrivacyPolicyDocument, PrivacyReviewRecord } from "@omnesis/types/privacy";
import type { PrivacyReviewResult } from "./reviewer.js";

let db: Database.Database;
const source = "fictional:scope";
const policyRevision = "a".repeat(64);
const policyDocument: PrivacyPolicyDocument = {
  policy: "Fictional policy",
  generation: 1,
  digest: "b".repeat(64),
  revision: policyRevision,
  updatedAt: 1,
  schema: null,
};
const authorization = createCorpusAuthorization(
  {
    principalId: "fictional-principal",
    grantId: "fictional-grant",
    grantRevision: 1,
    credentialId: "fictional-credential",
    accessTokenId: "fictional-token",
  },
  [
    {
      capability: "answer",
      sourceMode: "all",
      sourceIds: [],
      releaseMode: "unreviewed",
      policyFamilyId: null,
      policyRevision: null,
      privacyPolicy: null,
      filterRevision: 1,
      scopePolicies: [
        {
          sourceId: source,
          audience: { accessLevel: "fictional-level", capability: "answer" },
          rules: [
            {
              action: "share",
              match: [{ capability: "membership", field: "extra.labelIds", id: "visible" }],
            },
          ],
          otherwise: "hide",
        },
      ],
    },
  ],
  "answer",
)!;
const review: PrivacyReviewRecord = {
  recipeVersion: "privacy-reviewer-v1",
  provider: "test",
  model: "test",
  confidence: 1,
  policyRevision: policyRevision,
  findings: [],
  rationale: "Fictional review.",
};
beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  runSchemaSetup(db);
  runMigrations(db);
  publishProfile(db, "fictional", 5, LEDGER_PROFILE);
  db.exec(`INSERT INTO devices (id,name,kind,paired_at)
      VALUES ('00000000-0000-4000-8000-000000000001','Fictional collector','collector',1);
    INSERT INTO sources (id,type,account_id,device_id,created_at,updated_at)
      VALUES ('${source}','fictional','scope','00000000-0000-4000-8000-000000000001',1,1)`);
  addDocument("input");
  seedLiveIdentity();
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});
function addDocument(id: string) {
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,source_created_at,source_updated_at,ingested_at,updated_at,source_version)
    VALUES(?,'fictional-provider',?,?,'Fictional title','Fictional body','fictional-hash','2026-01-01','2026-01-01','2026-01-01','2026-01-01',3)`,
  ).run(id, source, id);
  facts(id, "visible");
}
/** Give a record one label: "visible" is the one the filter shares, any other hides it. */
function facts(id: string, label: string) {
  db.prepare("UPDATE documents SET metadata=? WHERE id=?").run(
    JSON.stringify({ documentType: "entry", extra: { labelIds: [label] } }),
    id,
  );
}
function begin(id = "task", conversationId?: string) {
  return beginAnswerTask(db, {
    ownerId: "fictional-owner",
    clientRequestId: id,
    question: "Fictional question",
    ...(conversationId ? { conversationId } : {}),
    scopeAuthorization: serializeCorpusAuthorization(authorization),
    ids: { workflowId: `workflow-${id}`, conversationId: `conversation-${id}`, taskId: id },
    now: 100,
    workflowExpiresAt: 10000,
  });
}
function complete(
  id = "task",
  complete = true,
  documentIds = ["input"],
  reviewRecord = review,
  expectedDisclosureRevision = id === "task" ? 0 : 1,
) {
  return completeAnswerTask(db, {
    taskId: id,
    ownerId: "fictional-owner",
    review: reviewRecord,
    now: 200,
    scopeReads: { complete, documentIds },
    outcome: {
      kind: "release",
      releaseId: `release-${id}`,
      answer: "Fictional answer",
      citations: [],
      expectedDisclosureRevision,
    },
  });
}

test("complete trusted readsets survive unrelated source mutations but never a hidden input", () => {
  begin();
  complete();
  addDocument("unrelated");
  expect(getAnswerTaskResponse(db, "task", "fictional-owner")?.status).toBe("released");
  facts("input", "hidden");
  expect(() => getAnswerTaskResponse(db, "task", "fictional-owner")).toThrow(
    /Source access changed/,
  );
  expect(() =>
    recordAnswerEgress(db, {
      id: "egress",
      taskId: "task",
      ownerId: "fictional-owner",
      endpoint: "/answer",
      now: 300,
    }),
  ).toThrow(/Source access changed/);
  expect(db.prepare("SELECT released_turns FROM answer_workflow_disclosure").get()).toEqual({
    released_turns: 1,
  });
});

test("hidden uncited snippets prevent candidate release and transcript pollution", () => {
  begin();
  facts("input", "hidden");
  expect(() => complete()).toThrow(/Source access changed/);
  expect(db.prepare("SELECT * FROM answer_releases").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM answer_messages").all()).toEqual([]);
});

test("an incomplete read set is checked for every document it does name", () => {
  begin();
  addDocument("unrelated");
  expect(() => complete("task", false, ["input"])).not.toThrow();
  facts("input", "hidden");
  expect(() => assertAnswerTaskScopeCurrent(db, "task")).toThrow(/Source access changed/);
});

test("held candidates cannot be approved after a fact change and free the conversation", () => {
  const task = begin();
  completeAnswerTask(db, {
    taskId: "task",
    ownerId: "fictional-owner",
    review,
    now: 200,
    scopeReads: { complete: true, documentIds: ["input"] },
    outcome: {
      kind: "approval",
      approvalId: "approval",
      candidateAnswer: "Fictional candidate",
      candidateCitations: [],
      candidateDigest: digestCandidate("Fictional candidate", []),
      releaseStatus: "released",
      reductions: [],
      expiresAt: 1000,
    },
  });
  facts("input", "hidden");
  expect(() =>
    resolvePrivacyApproval(db, {
      approvalId: "approval",
      action: "approve",
      releaseId: "release",
      now: 300,
      requestContext: { requestId: "owner-request", tokenId: null, deviceId: null },
    }),
  ).toThrow(/Source access changed/);
  expect(db.prepare("SELECT status FROM answer_tasks WHERE id='task'").get()).toEqual({
    status: "failed",
  });
  expect(begin("fresh", task.conversationId).state).toBe("running");
  expect(db.prepare("SELECT * FROM answer_releases").all()).toEqual([]);
});

test("history excludes whole stale turns before limiting and inherits every eligible witness", async () => {
  const first = begin();
  complete();
  addDocument("second-input");
  begin("second", first.conversationId);
  complete("second", true, ["second-input"]);
  facts("input", "hidden");
  begin("third", first.conversationId);
  const context = await loadPrivacyReviewerContext(
    db,
    first.workflowId,
    first.conversationId,
    "fictional-owner",
    "third",
  );
  expect(context.priorExternalConversation).toHaveLength(2);
  expect(context.scopeReads).toEqual({ complete: true, documentIds: ["second-input"] });
  expect(context.scopeHistoryWithheld).toBe(true);
  expect(context.cumulativeDisclosure.releasedTurns).toBe(2);
  expect(context.cumulativeDisclosure.revision).toBe(2);
});

test("final synchronous Direct guard rejects audit-await mutations while retaining unrelated new items", () => {
  const capture = createScopeReleaseCapture(db, authorization);
  capture.observer.recordDocuments(["input"]);
  capture.observer.markComplete();
  addDocument("unrelated");
  capture.assertCurrent();
  facts("input", "hidden");
  expect(() => capture.assertCurrent()).toThrow(/Source access changed/);
});

test("provenance overflow is sticky and bounded even after marking complete again", () => {
  const observer = createAnswerScopeReadObserver();
  observer.markComplete();
  observer.recordDocuments(
    Array.from({ length: MAX_ANSWER_SCOPE_DOCUMENTS + 1 }, (_, i) => `fictional-${i}`),
  );
  observer.markComplete();
  expect(observer.snapshot().complete).toBe(false);
  expect(observer.snapshot().documentIds).toHaveLength(MAX_ANSWER_SCOPE_DOCUMENTS);
});

test("a deleted input fails closed instead of matching a missing record", () => {
  begin();
  complete();
  db.prepare("DELETE FROM documents WHERE id='input'").run();
  expect(() => assertAnswerTaskScopeCurrent(db, "task")).toThrow(/Source access changed/);
});

test.each(["hidden", "unrelated"] as const)(
  "Answer runtime captures uncited input and rechecks after generation: %s",
  async (change) => {
    const service = new AnswerService({
      db,
      scopeHistoryReads: directReadPort(ANSWER_HISTORY_READS, db),
      writeGate: directWriteGate(db),
      agent: {
        async generateReadOnlyAnswerCandidate(_question, _history, _signal, _trace, options) {
          options?.scopeReads?.recordDocuments(["input"]);
          options?.scopeReads?.markComplete();
          if (change === "hidden") facts("input", "hidden");
          else addDocument("unrelated");
          return { answer: "Fictional generated answer", citations: [] };
        },
      },
      reviewer: { review: vi.fn() },
      policyStore: {
        get: async () => policyDocument,
        runIfRevision: async (_revision, operation) => operation(),
      },
      now: () => 500,
    });
    const pending = service.answer({
      ownerId: "fictional-owner",
      clientRequestId: "runtime",
      question: "Fictional question",
      corpusAuthorization: authorization,
    });
    if (change === "hidden") {
      await expect(pending).rejects.toMatchObject({ code: "authority_changed" });
      expect(db.prepare("SELECT * FROM answer_messages").all()).toEqual([]);
      expect(db.prepare("SELECT active_task_id FROM answer_conversations").get()).toEqual({
        active_task_id: null,
      });
    } else await expect(pending).resolves.toMatchObject({ status: "released" });
  },
);

function seedLiveIdentity() {
  if (db.prepare("SELECT 1 FROM access_principals WHERE id='fictional-principal'").get()) return;
  db.exec(`INSERT INTO access_principals(id,name,kind,created_at,updated_at)
    VALUES('fictional-principal','Fictional client','interactive',1,1);
    INSERT INTO access_grants(id,principal_id,name,created_at,updated_at)
    VALUES('fictional-grant','fictional-principal','Fictional grant',1,1);
    INSERT INTO principal_credentials(id,grant_id,oauth_client_id,kind,status,label,created_at)
    VALUES('fictional-credential','fictional-grant','fictional-client','interactive','active','Fictional credential',1);
    INSERT INTO oauth_access_tokens(id,credential_id,token_hash,audience,scope,grant_revision,created_at,expires_at)
    VALUES('fictional-token','fictional-credential','fictional-hash','https://example.com/mcp','omnesis:access',1,1,9007199254740991);
    INSERT INTO access_grant_capabilities(grant_id,capability,source_mode,source_ids,release_mode)
    VALUES('fictional-grant','answer','denylist','["fictional:scope"]','unreviewed');`);
  db.prepare(
    "INSERT INTO access_scope_capabilities VALUES('grant','fictional-grant','answer','all','[]',1,?)",
  ).run(JSON.stringify(encodeStoredScopePolicies(authorization.scopePolicies)));
}

function seedReviewedBinding() {
  commitPrivacyPolicy(db, {
    familyId: "fictional-family",
    familyName: "Fictional policy",
    policy: "Fictional policy",
    digest: "b".repeat(64),
    revision: policyRevision,
    expectedRevision: null,
    action: "bootstrap",
    revertedFromGeneration: null,
    createdAt: 1,
  });
  db.prepare(
    "UPDATE access_grant_capabilities SET release_mode='reviewed',policy_family_id='fictional-family' WHERE grant_id='fictional-grant'",
  ).run();
}

test.each([
  "UPDATE access_grants SET revision=2",
  "UPDATE principal_credentials SET revoked_at=1",
  "UPDATE oauth_access_tokens SET expires_at=1",
  "UPDATE access_principals SET revoked_at=1",
])("the final synchronous Answer release snapshot repeats live identity: %s", (mutation) => {
  seedLiveIdentity();
  begin();
  complete();
  assertAnswerTaskReleaseCurrent(db, "task", authorization);
  db.exec(mutation);
  expect(() => assertAnswerTaskReleaseCurrent(db, "task", authorization)).toThrow(
    /Source access changed/,
  );
});

test("bearer rotation and scope-preserving grant revisions do not orphan saved Answer proofs", () => {
  seedLiveIdentity();
  begin();
  complete();
  db.exec(`UPDATE oauth_access_tokens SET expires_at=1;
    UPDATE access_grants SET revision=2;
    INSERT INTO oauth_access_tokens(id,credential_id,token_hash,audience,scope,grant_revision,created_at,expires_at)
    VALUES('fictional-renewed-token','fictional-credential','fictional-renewed-hash','https://example.com/mcp','omnesis:access',2,2,9007199254740991)`);
  const current = { ...authorization, grantRevision: 2, accessTokenId: "fictional-renewed-token" };
  expect(() => assertAnswerTaskReleaseCurrent(db, "task", current)).not.toThrow();
  expect(() => assertAnswerTaskReleaseCurrent(db, "task")).not.toThrow();
  expect(() => assertAnswerTaskReleaseCurrent(db, "task", authorization)).toThrow(
    /Source access changed/,
  );
});

test.each([
  "UPDATE principal_credentials SET revoked_at=1",
  "UPDATE access_grants SET revoked_at=1",
  "UPDATE access_principals SET revoked_at=1",
  "UPDATE access_scope_capabilities SET source_mode='allowlist',source_ids='[]',filter_revision=2",
])("next-model-stage scope guard rejects changed stable authority: %s", (mutation) => {
  seedLiveIdentity();
  begin();
  const reads = { complete: true, documentIds: ["input"] };
  expect(() => assertAnswerRunScopeCurrent(db, "task", reads)).not.toThrow();
  db.exec(mutation);
  expect(() => assertAnswerRunScopeCurrent(db, "task", reads)).toThrow(/Source access changed/);
});

test("next-model-stage scope guard tolerates bearer expiry and scope-preserving grant revision", () => {
  seedLiveIdentity();
  begin();
  db.exec("UPDATE oauth_access_tokens SET expires_at=1; UPDATE access_grants SET revision=2");
  expect(() =>
    assertAnswerRunScopeCurrent(db, "task", { complete: true, documentIds: ["input"] }),
  ).not.toThrow();
});

test("native completion authorization rejects fact changes after prepare", () => {
  const device = createDevice(db, { name: "Fictional integration", kind: "agent" });
  begin();
  complete();
  db.prepare(
    `INSERT INTO answer_completion_deliveries(id,task_id,integration_device_id,native_conversation_id,status,claim_id,claim_expires_at,created_at,updated_at)
    VALUES('delivery','task',?,'fictional-native','claimed','claim',1000,1,1)`,
  ).run(device.id);
  facts("input", "hidden");
  expect(() =>
    authorizeAnswerCompletionDelivery(db, { deliveryId: "delivery", claimId: "claim", now: 300 }),
  ).toThrow(/Source access changed/);
  expect(
    db.prepare("SELECT status FROM answer_completion_deliveries WHERE id='delivery'").get(),
  ).toEqual({ status: "claimed" });
});

test("upgraded filtered snapshots without proven readsets fail closed, and unfiltered tasks remain usable", () => {
  seedLiveIdentity();
  const owner = externalAnswerOwnerId(authorization);
  beginAnswerTask(db, {
    ownerId: owner,
    question: "Legacy filtered question",
    clientRequestId: "legacy",
    ids: {
      workflowId: "legacy-workflow",
      conversationId: "legacy-conversation",
      taskId: "legacy-task",
    },
    now: 100,
    workflowExpiresAt: 10000,
  });
  expect(() => assertAnswerTaskScopeCurrent(db, "legacy-task")).toThrow(/Source access changed/);
  const unfiltered = beginAnswerTask(db, {
    ownerId: "fictional-unfiltered-owner",
    question: "Unfiltered question",
    clientRequestId: "unfiltered",
    ids: {
      workflowId: "unfiltered-workflow",
      conversationId: "unfiltered-conversation",
      taskId: "unfiltered-task",
    },
    now: 100,
    workflowExpiresAt: 10000,
  });
  expect(() => assertAnswerTaskScopeCurrent(db, unfiltered.taskId)).not.toThrow();
});

test("a fact change during reviewer work prevents both automatic and held release", async () => {
  seedReviewedBinding();
  const reviewed = createCorpusAuthorization(
    authorization,
    [
      {
        capability: "answer",
        sourceMode: "all",
        sourceIds: [],
        filterRevision: 1,
        scopePolicies: [...authorization.scopePolicies],
        releaseMode: "reviewed",
        policyFamilyId: "fictional-family",
        policyRevision: policyRevision,
        privacyPolicy: "fictional-family",
      },
    ],
    "answer",
  )!;
  const result: PrivacyReviewResult = {
    decision: "allow",
    reductions: [],
    hardStop: false,
    review,
    audit: {
      stage: "initial",
      envelopeDigest: "fictional-envelope",
      rawModelOutput: "{}",
      parsedModelOutput: {},
      fallbackCause: null,
      fallbackReason: null,
      hardStop: false,
      envelope: {
        releaseKind: "answer",
        userPolicy: { revision: policyRevision, text: "Fictional policy" },
        workflowPurpose: null,
        currentRequest: "Fictional question",
        priorExternalConversation: [],
        cumulativeDisclosure: {
          revision: 0,
          existenceRevision: 0,
          existenceSignals: 0,
          releasedTurns: 0,
          releasedCharacters: 0,
          olderTurnsOmitted: 0,
          categories: [],
        },
        reviewStage: "initial",
        candidateAnswer: "Fictional candidate",
        candidateCitations: [],
        watchDisclosure: null,
      },
    },
  };
  const policy = policyDocument;
  const service = new AnswerService({
    db,
    scopeHistoryReads: directReadPort(ANSWER_HISTORY_READS, db),
    writeGate: directWriteGate(db),
    agent: {
      async generateReadOnlyAnswerCandidate(_question, _history, _signal, _trace, options) {
        options?.scopeReads?.recordDocuments(["input"]);
        options?.scopeReads?.markComplete();
        return { answer: "Fictional candidate", citations: [] };
      },
    },
    reviewer: {
      async review() {
        facts("input", "hidden");
        return result;
      },
    },
    policyStore: {
      get: async () => policy,
      getFamily: async () => policy,
      runIfRevision: async (_revision, operation) => operation(),
    },
    now: () => 500,
  });
  await expect(
    service.answer({
      ownerId: "fictional-owner",
      clientRequestId: "review-race",
      question: "Fictional question",
      corpusAuthorization: reviewed,
    }),
  ).rejects.toMatchObject({ code: "authority_changed" });
  expect(db.prepare("SELECT * FROM answer_releases").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM answer_approvals").all()).toEqual([]);
});

test("credential revocation during candidate generation prevents the reviewer from receiving that candidate", async () => {
  seedReviewedBinding();
  const reviewed = createCorpusAuthorization(
    authorization,
    [
      {
        capability: "answer",
        sourceMode: "all",
        sourceIds: [],
        filterRevision: 1,
        scopePolicies: [...authorization.scopePolicies],
        releaseMode: "reviewed",
        policyFamilyId: "fictional-family",
        policyRevision,
        privacyPolicy: "fictional-family",
      },
    ],
    "answer",
  )!;
  const reviewer = vi.fn();
  const policy = policyDocument;
  const service = new AnswerService({
    db,
    scopeHistoryReads: directReadPort(ANSWER_HISTORY_READS, db),
    writeGate: directWriteGate(db),
    agent: {
      async generateReadOnlyAnswerCandidate(_q, _history, _signal, _trace, options) {
        options?.scopeReads?.recordDocuments(["input"]);
        options?.scopeReads?.markComplete();
        db.prepare(
          "UPDATE principal_credentials SET revoked_at=1 WHERE id='fictional-credential'",
        ).run();
        return { answer: "Fictional candidate", citations: [] };
      },
    },
    reviewer: { review: reviewer },
    policyStore: {
      get: async () => policy,
      getFamily: async () => policy,
      runIfRevision: async (_revision, operation) => operation(),
    },
    now: () => 500,
  });
  await expect(
    service.answer({
      ownerId: "fictional-owner",
      question: "Fictional question",
      clientRequestId: "revoke-before-review",
      corpusAuthorization: reviewed,
    }),
  ).rejects.toMatchObject({ code: "authority_changed" });
  expect(reviewer).not.toHaveBeenCalled();
  expect(db.prepare("SELECT * FROM answer_releases").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM answer_approvals").all()).toEqual([]);
});

test("an inherited uncited input remains fenced across a later Answer run without resetting spent disclosure", async () => {
  addDocument("second-input");
  let calls = 0;
  const service = new AnswerService({
    db,
    scopeHistoryReads: directReadPort(ANSWER_HISTORY_READS, db),
    writeGate: directWriteGate(db),
    agent: {
      async generateReadOnlyAnswerCandidate(_question, history, _signal, _trace, options) {
        calls++;
        options?.scopeReads?.recordDocuments([calls === 1 ? "input" : "second-input"]);
        options?.scopeReads?.markComplete();
        if (calls === 2) {
          expect(history).toHaveLength(2);
          facts("input", "hidden");
        }
        return { answer: "Fictional answer", citations: [] };
      },
    },
    reviewer: { review: vi.fn() },
    policyStore: {
      get: async () => policyDocument,
      runIfRevision: async (_revision, operation) => operation(),
    },
    now: () => 500,
  });
  const first = await service.answer({
    ownerId: "fictional-owner",
    clientRequestId: "first",
    question: "First fictional question",
    corpusAuthorization: authorization,
  });
  await expect(
    service.answer({
      ownerId: "fictional-owner",
      clientRequestId: "second",
      conversationId: first.conversationId,
      question: "Second fictional question",
      corpusAuthorization: authorization,
    }),
  ).rejects.toMatchObject({ code: "authority_changed" });
  expect(
    db.prepare("SELECT released_turns,revision FROM answer_workflow_disclosure").get(),
  ).toEqual({ released_turns: 1, revision: 1 });
  expect(db.prepare("SELECT COUNT(*) AS count FROM answer_messages").get()).toEqual({ count: 2 });
});

test("category context retains only eligible disclosures while keeping actual cumulative spend", async () => {
  const first = begin();
  complete("task", true, ["input"], {
    ...review,
    findings: [
      {
        category: "fictional-category",
        detailLevel: "summary",
        subject: "user",
        disposition: "allow",
        description: "Fictional finding",
      },
    ],
  });
  begin("next", first.conversationId);
  const visible = await loadPrivacyReviewerContext(
    db,
    first.workflowId,
    first.conversationId,
    "fictional-owner",
    "next",
  );
  expect(visible.cumulativeDisclosure.categories).toEqual([
    { category: "fictional-category", detailLevel: "summary", subject: "user", count: 1 },
  ]);
  expect(visible.scopeHistoryWithheld).toBe(false);
  facts("input", "hidden");
  const hidden = await loadPrivacyReviewerContext(
    db,
    first.workflowId,
    first.conversationId,
    "fictional-owner",
    "next",
  );
  expect(hidden.cumulativeDisclosure.categories).toEqual([]);
  expect(hidden.scopeHistoryWithheld).toBe(true);
  expect(hidden.cumulativeDisclosure.releasedTurns).toBe(1);
  expect(hidden.cumulativeDisclosure.revision).toBe(1);
});

test("history filtering happens before the context limit even past a page of hidden messages", async () => {
  const first = begin();
  complete();
  addDocument("second-input");
  begin("second", first.conversationId);
  complete("second", true, ["second-input"]);
  const insert = db.prepare(
    "INSERT INTO answer_messages(conversation_id,task_id,role,content,created_at) VALUES(?,'second','assistant','Fictional hidden history',300)",
  );
  for (let i = 0; i < 100; i++) insert.run(first.conversationId);
  facts("second-input", "hidden");
  begin("third", first.conversationId);
  const context = await loadPrivacyReviewerContext(
    db,
    first.workflowId,
    first.conversationId,
    "fictional-owner",
    "third",
  );
  expect(context.priorExternalConversation).toHaveLength(2);
  expect(context.scopeReads?.documentIds).toEqual(["input"]);
});

test("missing scoped-history worker fails before candidate generation instead of scanning main", async () => {
  const generate = vi.fn();
  const service = new AnswerService({
    db,
    writeGate: directWriteGate(db),
    agent: { generateReadOnlyAnswerCandidate: generate },
    reviewer: { review: vi.fn() },
    policyStore: {
      get: async () => policyDocument,
      runIfRevision: async (_revision, operation) => operation(),
    },
    now: () => 500,
  });
  await expect(
    service.answer({
      ownerId: "fictional-owner",
      question: "Fictional question",
      clientRequestId: "missing-reader",
      corpusAuthorization: authorization,
    }),
  ).rejects.toMatchObject({ code: "agent_unavailable" });
  expect(generate).not.toHaveBeenCalled();
});

test.each(["hidden", "unrelated"] as const)(
  "history page races preserve only current eligible context: %s",
  async (mutation) => {
    const first = begin();
    complete();
    for (let index = 0; index < 20; index++) {
      const id = `history-${index}`;
      begin(id, first.conversationId);
      complete(id, true, ["input"], review, index + 1);
    }
    const generate = vi.fn<AnswerCandidateGenerator["generateReadOnlyAnswerCandidate"]>(
      async (_question, history, _signal, _trace, options) => {
        expect(history).toHaveLength(40);
        options?.scopeReads?.recordDocuments(["input"]);
        options?.scopeReads?.markComplete();
        return { answer: "Fictional answer", citations: [] };
      },
    );
    let pages = 0;
    const reads = directReadPort(ANSWER_HISTORY_READS, db);
    const service = new AnswerService({
      db,
      scopeHistoryReads: {
        ...reads,
        async scopeHistoryPage(request) {
          const page = await reads.scopeHistoryPage(request);
          if (++pages === 1) {
            if (mutation === "hidden") facts("input", "hidden");
            else addDocument("unrelated");
          }
          return page;
        },
      },
      writeGate: directWriteGate(db),
      agent: { generateReadOnlyAnswerCandidate: generate },
      reviewer: { review: vi.fn() },
      policyStore: {
        get: async () => policyDocument,
        runIfRevision: async (_revision, operation) => operation(),
      },
      now: () => 500,
    });
    const pending = service.answer({
      ownerId: "fictional-owner",
      question: "Fictional question",
      clientRequestId: "history-page-race",
      conversationId: first.conversationId,
      corpusAuthorization: authorization,
    });
    if (mutation === "hidden")
      await expect(pending).rejects.toMatchObject({ code: "authority_changed" });
    else await expect(pending).resolves.toMatchObject({ status: "released" });
    expect(pages).toBeGreaterThan(1);
    expect(generate).toHaveBeenCalledTimes(mutation === "hidden" ? 0 : 1);
    expect(
      db
        .prepare("SELECT released_turns FROM answer_workflow_disclosure WHERE workflow_id=?")
        .get(first.workflowId),
    ).toEqual({ released_turns: mutation === "hidden" ? 21 : 22 });
  },
);

test.each(["hidden", "unrelated"] as const)(
  "full scoped history also fences changes across asynchronous pages: %s",
  async (mutation) => {
    const task = begin();
    complete();
    db.prepare(
      `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<200)
 INSERT INTO answer_messages(conversation_id,task_id,role,content,created_at) SELECT ?,'task','assistant','Fictional retained history',300 FROM n`,
    ).run(task.conversationId);
    const change = new Promise<void>((resolve) =>
      setImmediate(() => {
        if (mutation === "hidden") facts("input", "hidden");
        else addDocument("unrelated");
        resolve();
      }),
    );
    const history = loadReleasedAnswerHistory(db, task.conversationId, "fictional-owner");
    if (mutation === "hidden")
      await expect(history).rejects.toMatchObject({ code: "authority_changed" });
    else await expect(history).resolves.toHaveLength(202);
    await change;
  },
);
