// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCOPE_SUBSCRIPTIONS_ANSWER } from "@omnesis/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createToken } from "../data/repositories/TokenRepository.js";
import { runSchemaSetup } from "../data/schema.js";
import {
  claimDueCognitionRuns,
  enqueueCognitionRun,
  finalizeCognitionRun,
} from "../brain/storage/run-queue.js";
import { beginAnswerTask, completeAnswerTask } from "../privacy/store.js";
import {
  authorizeSubscriptionDeliveryCommit,
  addExistenceDisclosure,
  claimSubscriptionDeliveries,
  createSubscription,
  expireSubscriptions,
  fireSubscription,
  purgeSubscription,
  recordSubscriptionPrivacyReview,
  finalizeSubscriptionFiringAnswerEgress,
  issueSubscriptionFiringAnswerAuthority,
  resolveSubscriptionApproval,
  reconcileSubscriptionsPolicy,
  revokeSubscription,
  setSubscriptionStatus,
  settleSubscriptionDelivery,
  useSubscriptionFiringAnswerAuthority,
} from "./store-mutations.js";
import {
  getSubscriptionById,
  getSubscriptionForDevice,
  getSubscriptionApproval,
  listSubscriptionApprovals,
  validateSubscriptionFiringAnswerAuthority,
} from "./store-queries.js";
import { SubscriptionStorageCorruptionError } from "./store-codecs.js";
import type { SubscriptionCompiledPlan } from "./store-codecs.js";
import type { CreateSubscriptionMutation, ReviseSubscriptionMutation } from "./store-types.js";
import type { PrivacyReviewRecord } from "@omnesis/types/privacy";

const firingAnswerReview: PrivacyReviewRecord = {
  recipeVersion: "privacy-reviewer-v2",
  provider: "fictional-provider",
  model: "fictional-reviewer",
  confidence: 0.99,
  policyRevision: "policy-a",
  findings: [
    {
      category: "general",
      detailLevel: "summary",
      subject: "user",
      disposition: "allow",
      description: "A wholly fictional document summary.",
    },
  ],
  rationale: "Allowed by the fictional policy fixture.",
};

describe("subscription store", () => {
  let db: Database.Database;
  let deviceId: string;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runSchemaSetup(db);
    deviceId = createDevice(db, { name: "Fictional integration", kind: "cli" }).id;
  });

  afterEach(() => db.close());

  it("keeps semantic existence categories from two watches sharing a workflow", () => {
    const health = JSON.stringify([
      { category: "health", detailLevel: "existence", subject: "user", count: 1 },
    ]);
    const schedule = JSON.stringify([
      { category: "schedule", detailLevel: "existence", subject: "user", count: 1 },
    ]);
    const afterHealth = addExistenceDisclosure("[]", health);
    const afterSchedule = addExistenceDisclosure(JSON.stringify(afterHealth), schedule);
    const afterHealthAgain = addExistenceDisclosure(JSON.stringify(afterSchedule), health);

    expect(afterHealthAgain).toEqual([
      { category: "health", detailLevel: "existence", subject: "user", count: 2 },
      { category: "schedule", detailLevel: "existence", subject: "user", count: 1 },
    ]);
  });

  it("accounts a firing under the reviewer's semantic category", () => {
    expect(createSubscription(db, watchInput()).outcome).toBe("created");
    expect(
      recordSubscriptionPrivacyReview(db, {
        subscriptionId: "sub_northstar",
        approvalId: "sapp_northstar",
        revision: 1,
        policyRevision: "policy-a",
        expectedAnswerDisclosureRevision: 0,
        expectedExistenceDisclosureRevision: 0,
        decision: "allow",
        grantId: "sgrant_semantic_disclosure",
        grantExpiresAt: 9_000,
        resolvedAt: 200,
        review: {
          recipeVersion: "privacy-reviewer-test",
          provider: "test",
          model: "test",
          confidence: 1,
          policyRevision: "policy-a",
          findings: [
            {
              category: "health",
              detailLevel: "existence",
              subject: "user",
              disposition: "allow",
              description: "Synthetic health existence.",
            },
          ],
          rationale: "Allowed by the fictional policy.",
        },
        reviewedAt: 150,
      }).outcome,
    ).toBe("resolved");
    expect(
      fireSubscription(db, {
        firingId: "sfiring_semantic_disclosure",
        subscriptionId: "sub_northstar",
        revision: 1,
        indexEventKey: "fictional-semantic-disclosure",
        evidenceDocumentIds: [],
        policyRevision: "policy-a",
        firedAt: 300,
      }).outcome,
    ).toBe("fired");
    expect(
      db
        .prepare<
          [],
          { categories_json: string }
        >("SELECT categories_json FROM subscription_workflow_disclosure")
        .get()?.categories_json,
    ).toBe(
      JSON.stringify([{ category: "health", detailLevel: "existence", subject: "user", count: 1 }]),
    );
  });

  function createInput(
    overrides: Partial<CreateSubscriptionMutation> = {},
  ): CreateSubscriptionMutation {
    return {
      id: "sub_northstar",
      approvalId: "sapp_northstar",
      workflowId: "wf_northstar",
      integrationDeviceId: deviceId,
      ownerId: `device:${deviceId}`,
      clientRequestId: "request-northstar",
      requestFingerprint: "fingerprint-northstar",
      condition: {
        kind: "natural-language",
        description: 'when a new document semantically matches "Northstar is ready"',
      },
      reaction: {
        kind: "agent-workflow",
        instruction: "Prepare a fictional launch checklist.",
      },
      interpretation: {
        summary: "New document matching Northstar readiness",
        pushDetail: "existence",
      },
      compiledPlan: {
        version: 5,
        predicate: {
          kind: "watch-v2",
          watchId: "wat_northstar",
          watchName: "northstar-readiness",
          evidence: "documents",
          authoredBy: "integration",
        },
      },
      compilerVersion: "watch-v2-anchor",
      privacyCategories: ["documents"],
      policyRevision: "policy-a",
      createdAt: 100,
      expiresAt: 10_000,
      approvalExpiresAt: 2_000,
      workflowName: "Northstar subscription",
      workflowPurpose: "Prepare a fictional launch checklist.",
      createWorkflow: true,
      workflowExpiresAt: 10_000,
      ...overrides,
    };
  }

  /** A watch whose firing carries no documents: the condition became true. */
  function conditionOnlyPlan(): SubscriptionCompiledPlan {
    return {
      version: 5,
      predicate: {
        kind: "watch-v2",
        watchId: "wat_inventory",
        watchName: "fictional-inventory-has-rows",
        evidence: "condition-only",
        authoredBy: "operator",
      },
    };
  }

  function watchInput(
    overrides: Partial<CreateSubscriptionMutation> = {},
  ): CreateSubscriptionMutation {
    const plan = conditionOnlyPlan();
    return createInput({
      condition: {
        kind: "natural-language",
        description: "when the fictional inventory has at least one matching row",
      },
      interpretation: {
        summary: "Fictional inventory has at least one matching row",
        pushDetail: "existence",
      },
      compiledPlan: plan,
      compilerVersion: "test-watch-v2",
      privacyCategories: ["analytics:fictional_inventory"],
      ...overrides,
    });
  }

  function reviseInput(
    overrides: Partial<ReviseSubscriptionMutation> = {},
  ): ReviseSubscriptionMutation {
    const created = createInput();
    return {
      subscriptionId: created.id,
      integrationDeviceId: deviceId,
      expectedRevision: 1,
      approvalId: "sapp_revision_2",
      condition: created.condition,
      reaction: created.reaction,
      interpretation: created.interpretation,
      compiledPlan: created.compiledPlan,
      compilerVersion: created.compilerVersion,
      privacyCategories: created.privacyCategories,
      policyRevision: created.policyRevision,
      updatedAt: 300,
      expiresAt: created.expiresAt,
      approvalExpiresAt: created.approvalExpiresAt,
      ...overrides,
    };
  }

  function createAndApprove(): void {
    expect(createSubscription(db, createInput()).outcome).toBe("created");
    expect(
      resolveSubscriptionApproval(db, {
        approvalId: "sapp_northstar",
        decision: "approve",
        resolvedBy: { kind: "device", deviceId, tokenId: null },
        policyRevision: "policy-a",
        grantId: "sgrant_northstar",
        grantExpiresAt: 9_000,
        resolvedAt: 200,
      }).outcome,
    ).toBe("resolved");
  }

  /** Every audit title recorded for the fixture subscription, oldest first. */
  function auditTitles(): string[] {
    return db
      .prepare<[], { display_json: string }>(
        "SELECT display_json FROM subscription_audit_events ORDER BY sequence",
      )
      .all()
      .map((row) => (JSON.parse(row.display_json) as { title: string }).title);
  }

  // The operator reads these titles as the notification for a lifecycle event
  // and then opens a screen that calls the thing a watch. Naming the object
  // differently in the two places is the whole defect this pins down.
  it("names the object a watch in every lifecycle notification title", () => {
    createAndApprove();
    expect(
      setSubscriptionStatus(db, {
        subscriptionId: "sub_northstar",
        integrationDeviceId: deviceId,
        expectedRevision: 1,
        status: "paused",
        policyRevision: "policy-a",
        updatedAt: 300,
      }).outcome,
    ).toBe("updated");
    expect(
      setSubscriptionStatus(db, {
        subscriptionId: "sub_northstar",
        integrationDeviceId: deviceId,
        expectedRevision: 1,
        status: "active",
        policyRevision: "policy-a",
        updatedAt: 400,
      }).outcome,
    ).toBe("updated");
    expect(
      revokeSubscription(db, {
        subscriptionId: "sub_northstar",
        integrationDeviceId: deviceId,
        revokedAt: 500,
      }).outcome,
    ).toBe("revoked");

    const titles = auditTitles();
    expect(titles).toEqual([
      "Watch approval requested",
      "Watch approved",
      "Watch paused",
      "Watch resumed",
      "Watch revoked",
    ]);
    expect(titles.filter((title) => /subscription/i.test(title))).toEqual([]);
  });

  it("refuses policy activation when cumulative workflow disclosure changed", () => {
    expect(createSubscription(db, createInput()).outcome).toBe("created");
    db.prepare("UPDATE answer_workflow_disclosure SET revision = 1 WHERE workflow_id = ?").run(
      "wf_northstar",
    );
    expect(
      resolveSubscriptionApproval(db, {
        approvalId: "sapp_northstar",
        decision: "approve",
        resolvedBy: { kind: "policy" },
        policyRevision: "policy-a",
        expectedAnswerDisclosureRevision: 0,
        expectedExistenceDisclosureRevision: 0,
        grantId: "sgrant_stale_disclosure",
        grantExpiresAt: 9_000,
        resolvedAt: 200,
      }),
    ).toEqual({ outcome: "disclosure_changed" });
  });

  // Lifecycle and delivery raise their events from different modules but land
  // in one list the operator scrolls, and one event type — a queued
  // cancellation — is raised from both. Driving a firing all the way to a
  // claimed delivery keeps the two halves on the same noun.
  it("names the object a watch along the firing and delivery path too", () => {
    createAndApprove();
    issueFiringAuthority("sfr_vocabulary", "doc_vocabulary");

    const titles = auditTitles();
    expect(titles).toContain("Watch condition became true");
    expect(titles).toContain("Watch delivery queued");
    expect(titles).toContain("Watch delivery claimed");
    expect(titles.filter((title) => /subscription/i.test(title))).toEqual([]);
  });

  function insertFictionalDocument(documentId: string): void {
    db.prepare(
      `INSERT INTO documents
         (id, provider_id, source_id, external_id, title, content, content_hash,
          source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES (?, 'fictional', 'fictional:source', ?, 'Fictional Northstar record',
               'Wholly invented evidence.', ?, '2026-02-03T04:05:06Z',
               '2026-02-03T04:05:06Z', '2026-02-03T04:05:06Z',
               '2026-02-03T04:05:06Z')`,
    ).run(documentId, `external-${documentId}`, `hash-${documentId}`);
  }

  function enqueueFictionalEvaluation(id: string): void {
    createAndApprove();
    insertFictionalDocument(`doc_${id}`);
  }

  function issueFiringAuthority(firingId: string, documentId: string) {
    insertFictionalDocument(documentId);
    expect(
      fireSubscription(db, {
        firingId,
        subscriptionId: "sub_northstar",
        revision: 1,
        indexEventKey: `event-${firingId}`,
        evidenceDocumentIds: [documentId],
        policyRevision: "policy-a",
        firedAt: 300,
      }).outcome,
    ).toBe("fired");
    const [delivery] = claimSubscriptionDeliveries(db, {
      claimedAt: 400,
      policyRevision: "policy-a",
      limit: 1,
      leaseMs: 1_000,
      maxAttempts: 3,
    });
    if (!delivery) throw new Error("expected a claimed fictional subscription delivery");
    const token = createToken(
      db,
      deviceId as Parameters<typeof createToken>[1],
      [SCOPE_SUBSCRIPTIONS_ANSWER],
      `answer-${firingId}`,
      { ttlMs: 60_000 },
    );
    expect(
      issueSubscriptionFiringAnswerAuthority(db, {
        id: `sfaa_${firingId}`,
        deliveryId: delivery.id,
        claimId: delivery.claimId,
        tokenId: token.id,
        policyRevision: "policy-a",
        createdAt: 450,
        expiresAt: 8_000,
      }).outcome,
    ).toBe("issued");
    return { delivery, token };
  }

  function releaseFiringTask(taskId: string, firingId: string): void {
    const disclosureRevision =
      db
        .prepare<
          [string],
          { revision: number }
        >("SELECT revision FROM answer_workflow_disclosure WHERE workflow_id = ?")
        .get("wf_northstar")?.revision ?? 0;
    const task = beginAnswerTask(db, {
      ownerId: `device:${deviceId}`,
      workflowId: "wf_northstar",
      clientRequestId: `request-${taskId}`,
      question: "What fictional evidence caused this firing?",
      subscriptionFiringId: firingId,
      ids: {
        workflowId: `unused-workflow-${taskId}`,
        conversationId: `conversation-${taskId}`,
        taskId,
      },
      now: 500,
      workflowExpiresAt: 10_000,
    });
    completeAnswerTask(db, {
      taskId: task.taskId,
      ownerId: `device:${deviceId}`,
      review: firingAnswerReview,
      now: 550,
      outcome: {
        kind: "release",
        releaseId: `release-${taskId}`,
        answer: "A wholly fictional Northstar record matched.",
        expectedDisclosureRevision: disclosureRevision,
      },
    });
  }

  it("creates an immutable pending revision and safely replays the same request", () => {
    const first = createSubscription(db, createInput());
    const replay = createSubscription(
      db,
      createInput({
        id: "sub_unused",
        approvalId: "sapp_unused",
        workflowId: "wf_unused",
      }),
    );
    const conflict = createSubscription(
      db,
      createInput({ requestFingerprint: "different-fingerprint" }),
    );

    expect(first.outcome).toBe("created");
    expect(replay).toMatchObject({
      outcome: "replayed",
      subscription: { id: "sub_northstar", status: "pending_approval" },
    });
    expect(conflict.outcome).toBe("idempotency_conflict");
    expect(JSON.stringify(first)).not.toContain("compiledPlan");
    expect(
      setSubscriptionStatus(db, {
        subscriptionId: "sub_northstar",
        integrationDeviceId: deviceId,
        expectedRevision: 1,
        status: "paused",
        policyRevision: "policy-a",
        updatedAt: 150,
      }),
    ).toEqual({ outcome: "terminal" });
  });

  it("keeps physical watch dependencies on the trusted approval projection", () => {
    const input = watchInput({
      interpretation: {
        summary: "Physical table fictional_inventory column internal_state is above threshold",
        pushDetail: "existence",
      },
    });
    const created = createSubscription(db, input);
    expect(created).toMatchObject({
      outcome: "created",
      subscription: {
        interpretation: {
          summary: input.condition.description,
          pushDetail: "existence",
        },
        approval: {
          interpretedCondition: {
            summary: input.condition.description,
            pushDetail: "existence",
          },
        },
      },
    });
    expect(JSON.stringify(created)).not.toContain("internal_state");
    expect(getSubscriptionApproval(db, input.approvalId)?.interpretedCondition.summary).toContain(
      "internal_state",
    );
  });

  it("carries the compile-time watch measurement onto the approval it must inform", () => {
    const input = watchInput({
      grounding: {
        matchesNow: false,
        matchCount: 1,
        recentMatchCount: 0,
        latestMatchAt: 1_700_000_000_000,
        liveness: "dormant",
        horizonMs: 2_592_000_000,
      },
    });
    expect(createSubscription(db, input).outcome).toBe("created");

    expect(getSubscriptionApproval(db, input.approvalId)?.grounding).toEqual(input.grounding);

    // Nothing measured leaves the field null rather than a zero the operator
    // would read as "this watch has nothing to match".
    const unmeasured = watchInput({
      id: "sub_unmeasured",
      approvalId: "sapp_unmeasured",
      workflowId: "wf_unmeasured",
      clientRequestId: "request-unmeasured",
      grounding: undefined,
    });
    expect(createSubscription(db, unmeasured).outcome).toBe("created");
    expect(getSubscriptionApproval(db, "sapp_unmeasured")?.grounding).toBeNull();
  });

  it("projects a watch firing authority as approved condition plus firing time only", () => {
    expect(createSubscription(db, watchInput()).outcome).toBe("created");
    expect(
      resolveSubscriptionApproval(db, {
        approvalId: "sapp_northstar",
        decision: "approve",
        resolvedBy: { kind: "device", deviceId, tokenId: null },
        policyRevision: "policy-a",
        grantId: "sgrant_watch_authority",
        grantExpiresAt: 9_000,
        resolvedAt: 200,
      }).outcome,
    ).toBe("resolved");
    expect(
      fireSubscription(db, {
        firingId: "sfiring_watch_authority",
        subscriptionId: "sub_northstar",
        revision: 1,
        indexEventKey: "watch:fictional:1:initial",
        evidenceDocumentIds: [],
        policyRevision: "policy-a",
        firedAt: 300,
      }),
    ).toMatchObject({ outcome: "fired" });
    const [delivery] = claimSubscriptionDeliveries(db, {
      claimedAt: 400,
      policyRevision: "policy-a",
      limit: 1,
      leaseMs: 1_000,
      maxAttempts: 3,
    });
    if (!delivery) throw new Error("expected a claimed fictional watch delivery");
    const token = createToken(
      db,
      deviceId as Parameters<typeof createToken>[1],
      [SCOPE_SUBSCRIPTIONS_ANSWER],
      "fictional-watch-answer",
      { ttlMs: 60_000 },
    );
    const issued = issueSubscriptionFiringAnswerAuthority(db, {
      id: "sfaa_watch_authority",
      deliveryId: delivery.id,
      claimId: delivery.claimId,
      tokenId: token.id,
      policyRevision: "policy-a",
      createdAt: 450,
      expiresAt: 8_000,
    });
    expect(issued).toMatchObject({
      outcome: "issued",
      authority: {
        evidenceDocumentIds: [],
        firingEvidence: {
          kind: "watch-v2",
          conditionSummary: "Fictional inventory has at least one matching row",
          firedAt: 300,
        },
      },
    });
    if (issued.outcome !== "issued") throw new Error("expected watch authority issuance");
    expect(Object.keys(issued.authority.firingEvidence).sort()).toEqual([
      "conditionSummary",
      "firedAt",
      "kind",
    ]);
    const serializedAuthority = JSON.stringify(issued.authority);
    expect(serializedAuthority).not.toContain("fictional_inventory");
    expect(serializedAuthority).not.toContain("matching_rows");
    expect(serializedAuthority).not.toContain("catalogFingerprint");
    expect(serializedAuthority).not.toContain("SELECT");
  });

  it("carries what a condition-only firing observed into its answer evidence", () => {
    expect(createSubscription(db, watchInput()).outcome).toBe("created");
    expect(
      resolveSubscriptionApproval(db, {
        approvalId: "sapp_northstar",
        decision: "approve",
        resolvedBy: { kind: "device", deviceId, tokenId: null },
        policyRevision: "policy-a",
        grantId: "sgrant_observed",
        grantExpiresAt: 9_000,
        resolvedAt: 200,
      }).outcome,
    ).toBe("resolved");
    expect(
      fireSubscription(db, {
        firingId: "sfiring_observed",
        subscriptionId: "sub_northstar",
        revision: 1,
        indexEventKey: "watch:fictional:2:observed",
        evidenceDocumentIds: [],
        observation: { crates: 42, depot: "Northgate" },
        policyRevision: "policy-a",
        firedAt: 300,
      }),
    ).toMatchObject({ outcome: "fired" });
    const [delivery] = claimSubscriptionDeliveries(db, {
      claimedAt: 400,
      policyRevision: "policy-a",
      limit: 1,
      leaseMs: 1_000,
      maxAttempts: 3,
    });
    if (!delivery) throw new Error("expected a claimed fictional watch delivery");
    const token = createToken(
      db,
      deviceId as Parameters<typeof createToken>[1],
      [SCOPE_SUBSCRIPTIONS_ANSWER],
      "fictional-observed-answer",
      { ttlMs: 60_000 },
    );
    const issued = issueSubscriptionFiringAnswerAuthority(db, {
      id: "sfaa_observed",
      deliveryId: delivery.id,
      claimId: delivery.claimId,
      tokenId: token.id,
      policyRevision: "policy-a",
      createdAt: 450,
      expiresAt: 8_000,
    });
    if (issued.outcome !== "issued") throw new Error("expected watch authority issuance");
    expect(issued.authority.firingEvidence).toMatchObject({
      kind: "watch-v2",
      observation: { crates: 42, depot: "Northgate" },
    });
  });

  it("refuses to record an observation beside document evidence", () => {
    expect(createSubscription(db, createInput()).outcome).toBe("created");
    expect(
      resolveSubscriptionApproval(db, {
        approvalId: "sapp_northstar",
        decision: "approve",
        resolvedBy: { kind: "device", deviceId, tokenId: null },
        policyRevision: "policy-a",
        grantId: "sgrant_documented",
        grantExpiresAt: 9_000,
        resolvedAt: 200,
      }).outcome,
    ).toBe("resolved");
    insertFictionalDocument("doc_observed");
    expect(
      fireSubscription(db, {
        firingId: "sfiring_documented",
        subscriptionId: "sub_northstar",
        revision: 1,
        indexEventKey: "watch:fictional:3:documented",
        evidenceDocumentIds: ["doc_observed"],
        // Where documents are the evidence they already say what happened; a
        // second description of the same occurrence could disagree with them.
        observation: { crates: 42 },
        policyRevision: "policy-a",
        firedAt: 300,
      }),
    ).toMatchObject({ outcome: "fired" });
    const stored = db
      .prepare<
        [string],
        { observation_json: string | null }
      >("SELECT observation_json FROM subscription_firings WHERE id = ?")
      .get("sfiring_documented");
    expect(stored?.observation_json).toBeNull();
  });

  it("projects approval TTL expiry on trusted reads and status filters", () => {
    expect(createSubscription(db, createInput()).outcome).toBe("created");
    expect(getSubscriptionApproval(db, "sapp_northstar", 1_999)?.status).toBe("pending");
    expect(getSubscriptionApproval(db, "sapp_northstar", 2_000)?.status).toBe("expired");
    expect(listSubscriptionApprovals(db, "pending", 2_000)).toEqual([]);
    expect(listSubscriptionApprovals(db, "expired", 2_000)).toMatchObject([
      { id: "sapp_northstar", status: "expired" },
    ]);
    // Read projection is deliberately side-effect free; resolution remains
    // the writer that materializes expiry under the one-shot approval lock.
    expect(
      db
        .prepare<
          [],
          { status: string }
        >("SELECT status FROM subscription_approvals WHERE id = 'sapp_northstar'")
        .get()?.status,
    ).toBe("pending");
  });

  it("fails closed when immutable subscription JSON is corrupt", () => {
    createAndApprove();
    db.prepare(
      "UPDATE subscription_revisions SET condition_json = ? WHERE subscription_id = ?",
    ).run('{"kind":"natural-language","description":""}', "sub_northstar");
    expect(() => getSubscriptionForDevice(db, "sub_northstar", deviceId)).toThrow(
      SubscriptionStorageCorruptionError,
    );

    // A plan the codec cannot read is corruption too, and it must fail closed
    // where the plan is consulted: `fireSubscription` reads it to decide what
    // evidence a firing of this record is allowed to carry.
    db.prepare(
      "UPDATE subscription_revisions SET condition_json = ?, compiled_plan_json = ? WHERE subscription_id = ?",
    ).run(JSON.stringify(createInput().condition), '{"predicate":42}', "sub_northstar");
    insertFictionalDocument("doc_corrupt_plan");
    expect(() =>
      fireSubscription(db, {
        firingId: "sfiring_corrupt_plan",
        subscriptionId: "sub_northstar",
        revision: 1,
        indexEventKey: "event-corrupt-plan",
        evidenceDocumentIds: ["doc_corrupt_plan"],
        policyRevision: "policy-a",
        firedAt: 300,
      }),
    ).toThrow(SubscriptionStorageCorruptionError);
  });

  it("cannot approve a pending approval after its subscription is revoked", () => {
    expect(createSubscription(db, createInput()).outcome).toBe("created");
    expect(
      revokeSubscription(db, {
        subscriptionId: "sub_northstar",
        integrationDeviceId: deviceId,
        revokedAt: 150,
      }).outcome,
    ).toBe("revoked");

    expect(
      resolveSubscriptionApproval(db, {
        approvalId: "sapp_northstar",
        decision: "approve",
        resolvedBy: { kind: "device", deviceId, tokenId: null },
        policyRevision: "policy-a",
        grantId: "sgrant_must_not_exist",
        grantExpiresAt: 9_000,
        resolvedAt: 200,
      }).outcome,
    ).toBe("already_resolved");
    expect(getSubscriptionForDevice(db, "sub_northstar", deviceId)).toMatchObject({
      status: "revoked",
      approval: { status: "expired" },
    });
    expect(
      db
        .prepare<
          [],
          { count: number }
        >("SELECT COUNT(*) AS count FROM subscription_grants WHERE id = 'sgrant_must_not_exist'")
        .get()!.count,
    ).toBe(0);
  });

  it("treats a repeated status update at the same revision as an idempotent replay", () => {
    createAndApprove();
    const pause = {
      subscriptionId: "sub_northstar",
      integrationDeviceId: deviceId,
      expectedRevision: 1,
      status: "paused" as const,
      policyRevision: "policy-a",
      updatedAt: 250,
    };
    expect(setSubscriptionStatus(db, pause)).toMatchObject({
      outcome: "updated",
      subscription: { revision: 1, status: "paused", updatedAt: 250 },
    });
    expect(setSubscriptionStatus(db, { ...pause, updatedAt: 300 })).toMatchObject({
      outcome: "updated",
      subscription: { revision: 1, status: "paused", updatedAt: 250 },
    });
    expect(
      db
        .prepare<[], { count: number }>(
          `SELECT COUNT(*) AS count FROM subscription_audit_events
            WHERE subscription_id = 'sub_northstar' AND event_type = 'paused'`,
        )
        .get()?.count,
    ).toBe(1);
  });

  it("delivers the subscriber-authored reaction text byte-for-byte", () => {
    const instruction = "  Inspect the fictional launch record, then notify in the owner chat.  \n";
    expect(
      createSubscription(
        db,
        createInput({
          reaction: { kind: "agent-workflow", instruction },
        }),
      ).outcome,
    ).toBe("created");
    expect(
      resolveSubscriptionApproval(db, {
        approvalId: "sapp_northstar",
        decision: "approve",
        resolvedBy: { kind: "device", deviceId, tokenId: null },
        policyRevision: "policy-a",
        grantId: "sgrant_exact_reaction",
        grantExpiresAt: 9_000,
        resolvedAt: 200,
      }).outcome,
    ).toBe("resolved");
    insertFictionalDocument("doc_exact_reaction");
    expect(
      fireSubscription(db, {
        firingId: "sfiring_exact_reaction",
        subscriptionId: "sub_northstar",
        revision: 1,
        indexEventKey: "event-exact-reaction",
        evidenceDocumentIds: ["doc_exact_reaction"],
        policyRevision: "policy-a",
        firedAt: 300,
      }).outcome,
    ).toBe("fired");

    expect(
      claimSubscriptionDeliveries(db, {
        claimedAt: 400,
        policyRevision: "policy-a",
        limit: 1,
        leaseMs: 1_000,
        maxAttempts: 3,
      })[0]?.reaction,
    ).toEqual({ kind: "agent-workflow", instruction });
  });

  // ─── Operator watches (ios-push delivery) ────────────────────────────
  //
  // An operator watch runs the same pipeline but delivers to the operator's
  // own phone. These pin the store-level behaviours that differ.

  /** Create + approve an operator watch (ios-push reaction) beside the fixture. */
  function createOperatorWatch(): void {
    const plan: SubscriptionCompiledPlan = {
      version: 5,
      predicate: {
        kind: "watch-v2",
        watchId: "wat_gallery",
        watchName: "fictional-gallery-opening",
        evidence: "documents",
        authoredBy: "operator",
      },
    };
    expect(
      createSubscription(
        db,
        createInput({
          id: "sub_operator",
          approvalId: "sapp_operator",
          workflowId: "wf_operator",
          clientRequestId: "request-operator",
          requestFingerprint: "fingerprint-operator",
          reaction: { kind: "ios-push", title: "Gallery" },
          workflowName: "Operator watch",
          workflowPurpose: "Push a notification to the operator's devices.",
          compiledPlan: plan,
        }),
      ).outcome,
    ).toBe("created");
    expect(
      resolveSubscriptionApproval(db, {
        approvalId: "sapp_operator",
        decision: "approve",
        resolvedBy: { kind: "operator" },
        policyRevision: "policy-a",
        grantId: "sgrant_operator",
        grantExpiresAt: 9_000,
        resolvedAt: 200,
      }).outcome,
    ).toBe("resolved");
  }

  it("leaves an operator watch alone when the privacy policy changes", () => {
    // The policy fences what may LEAVE the corpus. An operator watch's firing
    // lands on the operator's own phone, so re-fencing it would gate an
    // internal mechanism on an exit concern — and would silently stop the
    // operator's own notifications every time they edited their policy.
    createAndApprove();
    createOperatorWatch();

    expect(reconcileSubscriptionsPolicy(db, "policy-b", 400)).toBe(1);

    expect(getSubscriptionForDevice(db, "sub_operator", deviceId, 400)).toMatchObject({
      status: "active",
      revision: 1,
      policyRevision: "policy-a",
    });
    expect(getSubscriptionForDevice(db, "sub_northstar", deviceId, 400)).toMatchObject({
      status: "pending_approval",
      revision: 2,
    });
  });

  it("delivers an operator watch even after the privacy policy moved", () => {
    // The claim gate asks for policy currency only of a wake that crosses to
    // an external agent. A push has no such boundary to re-authorize.
    createOperatorWatch();
    insertFictionalDocument("doc_operator_policy");
    expect(
      fireSubscription(db, {
        firingId: "sfiring_operator_policy",
        subscriptionId: "sub_operator",
        revision: 1,
        indexEventKey: "operator-policy-event",
        evidenceDocumentIds: ["doc_operator_policy"],
        policyRevision: "policy-a",
        firedAt: 300,
      }).outcome,
    ).toBe("fired");

    const claimed = claimSubscriptionDeliveries(db, {
      claimedAt: 400,
      policyRevision: "policy-b",
      limit: 10,
      leaseMs: 1_000,
      maxAttempts: 3,
    });
    expect(claimed.map((d) => d.subscriptionId)).toEqual(["sub_operator"]);
  });

  it("settles a push only from the state a push can reach", () => {
    // `pushed` and `delivered` reach the same end state from DIFFERENT
    // statuses: a push settles straight from `claimed` because it never
    // stages anything remotely, while a wake may only be marked delivered
    // once its commit was authorized. Accepting either from either status
    // would let a wake be recorded as delivered without ever crossing the
    // disclosure boundary.
    createOperatorWatch();
    insertFictionalDocument("doc_operator_settle");
    expect(
      fireSubscription(db, {
        firingId: "sfiring_operator_settle",
        subscriptionId: "sub_operator",
        revision: 1,
        indexEventKey: "operator-settle-event",
        evidenceDocumentIds: ["doc_operator_settle"],
        policyRevision: "policy-a",
        firedAt: 300,
      }).outcome,
    ).toBe("fired");
    const [delivery] = claimSubscriptionDeliveries(db, {
      claimedAt: 400,
      policyRevision: "policy-a",
      limit: 10,
      leaseMs: 1_000,
      maxAttempts: 3,
    });
    expect(delivery).toBeDefined();

    // `delivered` from `claimed` is the wake's transition and is refused here.
    expect(
      settleSubscriptionDelivery(db, {
        deliveryId: delivery!.id,
        claimId: delivery!.claimId,
        settledAt: 410,
        outcome: { kind: "delivered", acceptedAt: 410, localRunId: "trf_fictional" },
      }),
    ).toEqual({ outcome: "stale_claim" });

    expect(
      settleSubscriptionDelivery(db, {
        deliveryId: delivery!.id,
        claimId: delivery!.claimId,
        settledAt: 420,
        outcome: { kind: "pushed", acceptedAt: 420, localRunId: "trf_fictional" },
      }),
    ).toMatchObject({ outcome: "settled", status: "delivered" });
    expect(
      db
        .prepare<
          [],
          { status: string }
        >("SELECT status FROM subscription_firings WHERE id = 'sfiring_operator_settle'")
        .get(),
    ).toEqual({ status: "delivered" });
  });

  it("turns a privacy-policy change into a fresh disabled revision and approval", () => {
    createAndApprove();
    db.prepare(
      `INSERT INTO documents
         (id, provider_id, source_id, external_id, title, content, content_hash,
          source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES ('doc_policy', 'fictional', 'fictional:source', 'external_policy',
               'Northstar policy fixture', 'Wholly fictional evidence.', 'hash-policy',
               '2026-02-03T04:05:06Z', '2026-02-03T04:05:06Z',
               '2026-02-03T04:05:06Z', '2026-02-03T04:05:06Z')`,
    ).run();
    expect(
      fireSubscription(db, {
        firingId: "sfiring_policy",
        subscriptionId: "sub_northstar",
        revision: 1,
        indexEventKey: "policy-event",
        evidenceDocumentIds: ["doc_policy"],
        policyRevision: "policy-a",
        firedAt: 300,
      }).outcome,
    ).toBe("fired");

    expect(reconcileSubscriptionsPolicy(db, "policy-b", 400)).toBe(1);
    expect(reconcileSubscriptionsPolicy(db, "policy-b", 401)).toBe(0);
    const subscription = getSubscriptionForDevice(db, "sub_northstar", deviceId, 400);
    expect(subscription).toMatchObject({
      status: "pending_approval",
      revision: 2,
      policyRevision: "policy-b",
      approval: { status: "pending" },
    });
    expect(
      db
        .prepare<
          [],
          { revoked_at: number | null }
        >("SELECT revoked_at FROM subscription_grants WHERE id = 'sgrant_northstar'")
        .get()?.revoked_at,
    ).toBe(400);
    expect(
      db
        .prepare<
          [],
          { status: string; last_error: string }
        >("SELECT status, last_error FROM subscription_deliveries WHERE firing_id = 'sfiring_policy'")
        .get(),
    ).toEqual({ status: "cancel_pending", last_error: "privacy policy changed" });
    expect(
      fireSubscription(db, {
        firingId: "sfiring_stale_policy",
        subscriptionId: "sub_northstar",
        revision: 1,
        indexEventKey: "stale-policy-event",
        evidenceDocumentIds: ["doc_policy"],
        policyRevision: "policy-a",
        firedAt: 410,
      }).outcome,
    ).toBe("stale_revision");
    expect(
      db
        .prepare<[], { count: number }>(
          `SELECT COUNT(*) AS count FROM subscription_audit_events
            WHERE subscription_id = 'sub_northstar'
              AND event_type = 'policy_reapproval_requested'`,
        )
        .get()?.count,
    ).toBe(1);
  });

  it("preserves an operator pause through policy reapproval", () => {
    createAndApprove();
    expect(
      setSubscriptionStatus(db, {
        subscriptionId: "sub_northstar",
        integrationDeviceId: deviceId,
        expectedRevision: 1,
        status: "paused",
        policyRevision: "policy-a",
        updatedAt: 250,
      }).outcome,
    ).toBe("updated");

    expect(reconcileSubscriptionsPolicy(db, "policy-b", 400)).toBe(1);
    expect(getSubscriptionForDevice(db, "sub_northstar", deviceId, 400)).toMatchObject({
      status: "paused",
      revision: 2,
      approval: { status: "pending" },
    });
    const approvalId = db
      .prepare<
        [],
        { id: string }
      >("SELECT id FROM subscription_approvals WHERE subscription_id = 'sub_northstar' AND revision = 2")
      .get()!.id;
    expect(
      resolveSubscriptionApproval(db, {
        approvalId,
        decision: "approve",
        resolvedBy: { kind: "device", deviceId, tokenId: null },
        policyRevision: "policy-b",
        grantId: "sgrant_policy_reapproval",
        grantExpiresAt: 9_000,
        resolvedAt: 450,
      }).outcome,
    ).toBe("resolved");
    expect(getSubscriptionForDevice(db, "sub_northstar", deviceId, 450)?.status).toBe("paused");

    expect(
      setSubscriptionStatus(db, {
        subscriptionId: "sub_northstar",
        integrationDeviceId: deviceId,
        expectedRevision: 2,
        status: "active",
        policyRevision: "policy-b",
        updatedAt: 500,
      }).outcome,
    ).toBe("updated");
  });

  it("revokes queued delivery and Answer authority when firing evidence is deleted", () => {
    createAndApprove();
    const { token } = issueFiringAuthority("sfiring_deleted_evidence", "doc_deleted_evidence");

    db.prepare("DELETE FROM documents WHERE id = 'doc_deleted_evidence'").run();

    expect(
      db
        .prepare<
          [],
          { status: string }
        >("SELECT status FROM subscription_firings WHERE id = 'sfiring_deleted_evidence'")
        .get(),
    ).toEqual({ status: "blocked" });
    expect(
      db
        .prepare<
          [],
          { status: string; last_error: string }
        >("SELECT status, last_error FROM subscription_deliveries WHERE firing_id = 'sfiring_deleted_evidence'")
        .get(),
    ).toEqual({
      status: "cancel_pending",
      last_error: "firing evidence was privacy-deleted",
    });
    expect(
      db
        .prepare<
          [],
          { revoked_at: number | null }
        >("SELECT revoked_at FROM subscription_firing_answer_authorities WHERE firing_id = 'sfiring_deleted_evidence'")
        .get()?.revoked_at,
    ).not.toBeNull();
    expect(
      validateSubscriptionFiringAnswerAuthority(db, {
        tokenId: token.id,
        firingId: "sfiring_deleted_evidence",
        policyRevision: "policy-a",
        now: 600,
      }),
    ).toEqual({ outcome: "inactive" });
  });

  it("rejects final Answer egress when task scope, policy, or revocation changed", () => {
    createAndApprove();
    const first = issueFiringAuthority("sfiring_final_boundary", "doc_final_boundary");
    expect(
      authorizeSubscriptionDeliveryCommit(db, {
        deliveryId: first.delivery.id,
        claimId: first.delivery.claimId,
        policyRevision: "policy-a",
        authorizedAt: 475,
      }),
    ).toEqual({ outcome: "authorized" });
    releaseFiringTask("task_wrong_firing", "sfiring_other");

    expect(
      finalizeSubscriptionFiringAnswerEgress(db, {
        tokenId: first.token.id,
        firingId: "sfiring_final_boundary",
        policyRevision: "policy-a",
        taskId: "task_wrong_firing",
        ownerId: `device:${deviceId}`,
        egressId: "egress_wrong_firing",
        recordedAt: 600,
      }),
    ).toEqual({ outcome: "task_scope_mismatch" });
    expect(db.prepare("SELECT id FROM answer_egress_events").all()).toEqual([]);

    releaseFiringTask("task_exact_firing", "sfiring_final_boundary");
    expect(
      finalizeSubscriptionFiringAnswerEgress(db, {
        tokenId: first.token.id,
        firingId: "sfiring_final_boundary",
        policyRevision: "policy-b",
        taskId: "task_exact_firing",
        ownerId: `device:${deviceId}`,
        egressId: "egress_stale_policy",
        recordedAt: 610,
      }),
    ).toEqual({ outcome: "policy_changed" });
    expect(db.prepare("SELECT id FROM answer_egress_events").all()).toEqual([]);

    expect(
      revokeSubscription(db, {
        subscriptionId: "sub_northstar",
        integrationDeviceId: deviceId,
        revokedAt: 620,
      }).outcome,
    ).toBe("revoked");
    expect(
      finalizeSubscriptionFiringAnswerEgress(db, {
        tokenId: first.token.id,
        firingId: "sfiring_final_boundary",
        policyRevision: "policy-a",
        taskId: "task_exact_firing",
        ownerId: `device:${deviceId}`,
        egressId: "egress_after_revoke",
        recordedAt: 630,
      }),
    ).toEqual({ outcome: "revoked" });
    expect(db.prepare("SELECT id FROM answer_egress_events").all()).toEqual([]);
  });

  it("durably retries delivery leases and rejects a stale acknowledgement", () => {
    createAndApprove();
    db.prepare(
      `INSERT INTO documents
         (id, provider_id, source_id, external_id, title, content, content_hash,
          source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES ('doc_private_fictional', 'fictional', 'fictional:source',
               'external-private-fictional', 'Private fictional record',
               'Wholly invented evidence.', 'hash-private-fictional',
               '2026-02-03T04:05:06Z', '2026-02-03T04:05:06Z',
               '2026-02-03T04:05:06Z', '2026-02-03T04:05:06Z')`,
    ).run();
    expect(
      fireSubscription(db, {
        firingId: "sfiring_retry",
        subscriptionId: "sub_northstar",
        revision: 1,
        indexEventKey: "fictional-index-retry",
        evidenceDocumentIds: ["doc_private_fictional"],
        policyRevision: "policy-a",
        firedAt: 300,
      }).outcome,
    ).toBe("fired");
    const [first] = claimSubscriptionDeliveries(db, {
      claimedAt: 400,
      policyRevision: "policy-a",
      limit: 10,
      leaseMs: 100,
      maxAttempts: 3,
    });
    expect(first?.attempt).toBe(1);
    expect(JSON.stringify(first)).not.toMatch(/evidence|compiled|document|title/i);

    const [second] = claimSubscriptionDeliveries(db, {
      claimedAt: 501,
      policyRevision: "policy-a",
      limit: 10,
      leaseMs: 100,
      maxAttempts: 3,
    });
    expect(second).toMatchObject({ id: first!.id, attempt: 2 });
    expect(second!.claimId).not.toBe(first!.claimId);
    expect(
      settleSubscriptionDelivery(db, {
        deliveryId: first!.id,
        claimId: first!.claimId,
        settledAt: 520,
        outcome: {
          kind: "delivered",
          acceptedAt: 510,
          localRunId: "stale-fictional-run",
        },
      }),
    ).toEqual({ outcome: "stale_claim" });
    expect(
      settleSubscriptionDelivery(db, {
        deliveryId: second!.id,
        claimId: second!.claimId,
        settledAt: 530,
        outcome: {
          kind: "retry",
          nextAttemptAt: 600,
          error: "fictional transport interruption",
        },
      }),
    ).toEqual({ outcome: "settled", status: "retry" });
    expect(
      claimSubscriptionDeliveries(db, {
        claimedAt: 599,
        policyRevision: "policy-a",
        limit: 10,
        leaseMs: 100,
        maxAttempts: 3,
      }),
    ).toEqual([]);
    expect(
      claimSubscriptionDeliveries(db, {
        claimedAt: 600,
        policyRevision: "policy-b",
        limit: 10,
        leaseMs: 100,
        maxAttempts: 3,
      }),
    ).toEqual([]);
    expect(
      db
        .prepare<
          [],
          { status: string; last_error: string }
        >("SELECT status, last_error FROM subscription_deliveries WHERE id = 'sdel_sfiring_retry'")
        .get(),
    ).toEqual({
      status: "cancel_pending",
      last_error: "subscription delivery authority changed",
    });
    const [cleanup] = claimSubscriptionDeliveries(db, {
      claimedAt: 601,
      policyRevision: "policy-b",
      limit: 10,
      leaseMs: 100,
      maxAttempts: 3,
    });
    expect(cleanup).toMatchObject({
      id: "sdel_sfiring_retry",
      phase: "cancel",
    });
    expect(
      settleSubscriptionDelivery(db, {
        deliveryId: cleanup!.id,
        claimId: cleanup!.claimId,
        settledAt: 602,
        outcome: { kind: "cancelled", cancelledAt: 602 },
      }),
    ).toEqual({ outcome: "settled", status: "failed" });
    expect(
      db
        .prepare<
          [],
          { status: string }
        >("SELECT status FROM subscription_firings WHERE id = 'sfiring_retry'")
        .get()?.status,
    ).toBe("blocked");
  });

  /**
   * The anchor is unique on `(subscription, revision, index_event_key)`, and a
   * miss on that constraint is not an error — `fireSubscription` treats it as
   * an idempotent replay and hands back the firing that is already there. So
   * the key decides whether two firings are two events or one, and getting it
   * wrong loses the second silently: no error, no log, and an agent that is
   * simply never told.
   *
   * A broadcast arm re-judges every live cell at one tick, so several firings
   * about different evidence share a `watchId:seq`. These two cases pin both
   * halves of the constraint against the real table rather than a stub that
   * has no uniqueness of its own.
   */
  describe("two firings at one sequence", () => {
    it("keeps them apart when their identities differ, each with its own evidence", () => {
      createAndApprove();
      insertFictionalDocument("doc_cell_a");
      insertFictionalDocument("doc_cell_b");

      // Same watch, same tick — different cells of a keyed node.
      const first = fireSubscription(db, {
        firingId: "sfiring_cell_a",
        subscriptionId: "sub_northstar",
        revision: 1,
        indexEventKey: "w-1:41:notify:ka",
        evidenceDocumentIds: ["doc_cell_a"],
        policyRevision: "policy-a",
        firedAt: 300,
      });
      const second = fireSubscription(db, {
        firingId: "sfiring_cell_b",
        subscriptionId: "sub_northstar",
        revision: 1,
        indexEventKey: "w-1:41:notify:kb",
        evidenceDocumentIds: ["doc_cell_b"],
        policyRevision: "policy-a",
        firedAt: 300,
      });

      expect(first.outcome).toBe("fired");
      expect(second.outcome).toBe("fired");
      const firings = db
        .prepare<
          [],
          { id: string; index_event_key: string; evidence_count: number }
        >("SELECT id, index_event_key, evidence_count FROM subscription_firings ORDER BY id")
        .all();
      expect(firings.map((f) => f.id)).toEqual(["sfiring_cell_a", "sfiring_cell_b"]);
      // Each carries its own cell's evidence. Collapsing the two would hand
      // the second cell's agent the first cell's documents.
      expect(firings.every((f) => f.evidence_count === 1)).toBe(true);
      // And each gets a delivery, which is what actually wakes somebody.
      expect(
        db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM subscription_deliveries").get()?.n,
      ).toBe(2);
    });

    it("still folds a genuine repeat of one identity into the firing already there", () => {
      createAndApprove();
      insertFictionalDocument("doc_repeat");

      const first = fireSubscription(db, {
        firingId: "sfiring_repeat_first",
        subscriptionId: "sub_northstar",
        revision: 1,
        indexEventKey: "w-1:41:notify:ka",
        evidenceDocumentIds: ["doc_repeat"],
        policyRevision: "policy-a",
        firedAt: 300,
      });
      // The runtime re-reporting a firing it already reported — a retry after
      // a crash, not a second cell. This must not wake anyone twice.
      const repeat = fireSubscription(db, {
        firingId: "sfiring_repeat_second",
        subscriptionId: "sub_northstar",
        revision: 1,
        indexEventKey: "w-1:41:notify:ka",
        evidenceDocumentIds: ["doc_repeat"],
        policyRevision: "policy-a",
        firedAt: 300,
      });

      expect(first.outcome).toBe("fired");
      // Named, not silently folded — the caller can tell the difference
      // between a firing it caused and one that was already there.
      expect(repeat.outcome).toBe("duplicate");
      expect(
        db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM subscription_firings").get()?.n,
      ).toBe(1);
      expect(
        db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM subscription_deliveries").get()?.n,
      ).toBe(1);
    });
  });

  describe("purge", () => {
    function countRows(table: string, where: string, ...params: unknown[]): number {
      return (
        db
          .prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
          .get(...params)?.n ?? 0
      );
    }

    it("hard-deletes a revoked subscription's whole constellation", () => {
      createAndApprove();
      const { token } = issueFiringAuthority("sfiring_purge", "doc_purge_evidence");
      insertFictionalDocument("doc_purge_candidate");
      expect(
        revokeSubscription(db, {
          subscriptionId: "sub_northstar",
          integrationDeviceId: deviceId,
          revokedAt: 600,
        }).outcome,
      ).toBe("revoked");

      const result = purgeSubscription(db, { subscriptionId: "sub_northstar" });
      expect(result).toEqual({
        outcome: "purged",
        purge: {
          subscriptionId: "sub_northstar",
          status: "revoked",
          revisionsDeleted: 1,
          firingsDeleted: 1,
          answerTokensDeleted: 1,
          workflowsDeleted: 1,
        },
      });

      for (const [table, where] of [
        ["subscriptions", "id = 'sub_northstar'"],
        ["subscription_revisions", "subscription_id = 'sub_northstar'"],
        ["subscription_approvals", "subscription_id = 'sub_northstar'"],
        ["subscription_grants", "subscription_id = 'sub_northstar'"],
        ["subscription_firings", "subscription_id = 'sub_northstar'"],
        ["subscription_firing_evidence", "firing_id = 'sfiring_purge'"],
        ["subscription_deliveries", "subscription_id = 'sub_northstar'"],
        ["subscription_firing_answer_authorities", "subscription_id = 'sub_northstar'"],
        ["subscription_audit_events", "subscription_id = 'sub_northstar'"],
        ["subscription_workflow_disclosure", "workflow_id = 'wf_northstar'"],
        ["answer_workflows", "id = 'wf_northstar'"],
        ["answer_workflow_disclosure", "workflow_id = 'wf_northstar'"],
      ] as const) {
        expect(countRows(table, where), `${table} not emptied`).toBe(0);
      }
      expect(countRows("tokens", "id = ?", token.id)).toBe(0);
      // Corpus documents are evidence, not subscription property.
      expect(countRows("documents", "id = 'doc_purge_evidence'")).toBe(1);
    });

    it("purges an expired subscription", () => {
      createAndApprove();
      expect(expireSubscriptions(db, 10_001)).toBe(1);
      const result = purgeSubscription(db, { subscriptionId: "sub_northstar" });
      expect(result.outcome).toBe("purged");
      if (result.outcome === "purged") expect(result.purge.status).toBe("expired");
      expect(countRows("subscriptions", "id = 'sub_northstar'")).toBe(0);
    });

    it.each(["pending_approval", "active", "paused", "denied"] as const)(
      "refuses to delete a %s subscription",
      (status) => {
        if (status === "pending_approval") {
          expect(createSubscription(db, createInput()).outcome).toBe("created");
        } else if (status === "denied") {
          expect(createSubscription(db, createInput()).outcome).toBe("created");
          expect(
            resolveSubscriptionApproval(db, {
              approvalId: "sapp_northstar",
              decision: "deny",
              resolvedBy: { kind: "device", deviceId, tokenId: null },
              policyRevision: "policy-a",
              grantId: "sgrant_denied",
              grantExpiresAt: 9_000,
              resolvedAt: 200,
            }).outcome,
          ).toBe("resolved");
        } else {
          createAndApprove();
          if (status === "paused") {
            expect(
              setSubscriptionStatus(db, {
                subscriptionId: "sub_northstar",
                integrationDeviceId: deviceId,
                expectedRevision: 1,
                status: "paused",
                policyRevision: "policy-a",
                updatedAt: 300,
              }).outcome,
            ).toBe("updated");
          }
        }
        expect(purgeSubscription(db, { subscriptionId: "sub_northstar" })).toEqual({
          outcome: "not_purgeable",
          status,
        });
        expect(countRows("subscriptions", "id = 'sub_northstar'")).toBe(1);
        expect(countRows("answer_workflows", "id = 'wf_northstar'")).toBe(1);
      },
    );

    it("reports not_found for an unknown subscription", () => {
      expect(purgeSubscription(db, { subscriptionId: "sub_unknown" })).toEqual({
        outcome: "not_found",
      });
    });

    it("keeps a workflow another subscription still references", () => {
      createAndApprove();
      expect(
        createSubscription(
          db,
          createInput({
            id: "sub_sibling",
            approvalId: "sapp_sibling",
            clientRequestId: "request-sibling",
            requestFingerprint: "fingerprint-sibling",
            createWorkflow: false,
          }),
        ).outcome,
      ).toBe("created");
      expect(
        revokeSubscription(db, {
          subscriptionId: "sub_northstar",
          integrationDeviceId: deviceId,
          revokedAt: 600,
        }).outcome,
      ).toBe("revoked");
      const result = purgeSubscription(db, { subscriptionId: "sub_northstar" });
      expect(result.outcome).toBe("purged");
      if (result.outcome === "purged") expect(result.purge.workflowsDeleted).toBe(0);
      expect(countRows("answer_workflows", "id = 'wf_northstar'")).toBe(1);
      expect(countRows("subscriptions", "id = 'sub_sibling'")).toBe(1);

      // Once the sibling is terminal and purged too, the workflow goes with it.
      expect(
        revokeSubscription(db, {
          subscriptionId: "sub_sibling",
          integrationDeviceId: deviceId,
          revokedAt: 700,
        }).outcome,
      ).toBe("revoked");
      const second = purgeSubscription(db, { subscriptionId: "sub_sibling" });
      expect(second.outcome).toBe("purged");
      if (second.outcome === "purged") expect(second.purge.workflowsDeleted).toBe(1);
      expect(countRows("answer_workflows", "id = 'wf_northstar'")).toBe(0);
    });

    it("keeps a workflow an answer task still references", () => {
      createAndApprove();
      beginAnswerTask(db, {
        ownerId: `device:${deviceId}`,
        workflowId: "wf_northstar",
        clientRequestId: "request-purge-answer",
        question: "A wholly fictional question?",
        ids: {
          workflowId: "unused-workflow-purge",
          conversationId: "conversation-purge",
          taskId: "task-purge",
        },
        now: 500,
        workflowExpiresAt: 10_000,
      });
      expect(
        revokeSubscription(db, {
          subscriptionId: "sub_northstar",
          integrationDeviceId: deviceId,
          revokedAt: 600,
        }).outcome,
      ).toBe("revoked");
      const result = purgeSubscription(db, { subscriptionId: "sub_northstar" });
      expect(result.outcome).toBe("purged");
      if (result.outcome === "purged") expect(result.purge.workflowsDeleted).toBe(0);
      expect(countRows("answer_workflows", "id = 'wf_northstar'")).toBe(1);
    });
  });
});
