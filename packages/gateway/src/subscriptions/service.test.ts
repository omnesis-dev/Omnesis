// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SqliteDatabase from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevice, updateDeviceCapabilities } from "../data/repositories/DeviceRepository.js";
import { runSchemaSetup } from "../data/schema.js";
import { PRIVACY_POLICY_FILENAME, PrivacyPolicyStore } from "../privacy/policy-store.js";
import { directWriteGate, type WriteGate } from "../write-gate.js";
import { SubscriptionService, SubscriptionServiceError } from "./service.js";

describe("SubscriptionService watch privacy policy", () => {
  let db: SqliteDatabase.Database;
  let deviceId: string;
  let configDir: string;
  let sequence: number;

  const CONDITION = {
    kind: "natural-language" as const,
    description: 'when a new document has title exactly "Fictional quarterly readout"',
  };
  const SEMANTIC_CONDITION = {
    kind: "natural-language" as const,
    description: 'when a new document semantically matches "Fictional readiness signal"',
  };
  const REACTION = {
    kind: "agent-workflow" as const,
    instruction: "Prepare the invented readout checklist.",
  };
  const INTEGRATION_NAME = "Northstar Agent";

  function policyReviewResult(decision: "allow" | "ask" | "deny") {
    return {
      decision,
      review: {
        review: {
          recipeVersion: "privacy-reviewer-test",
          provider: "test",
          model: "test",
          confidence: 1,
          policyRevision: "ignored-by-fixture",
          findings: [
            {
              category: "schedule",
              detailLevel: "existence",
              subject: "user",
              disposition:
                decision === "allow" ? "allow" : decision === "ask" ? "approval" : "deny",
              description: "Synthetic schedule existence.",
            },
          ],
          rationale: "Synthetic policy decision.",
        },
      },
    } as never;
  }

  /**
   * The compiled half every create supplies.
   *
   * The service stores what it is handed: a watch definition compiled and
   * validated by the engine that will evaluate it. These tests are about what
   * happens to the record afterwards — the reviewer, the grant, the approval —
   * so the plan is the smallest honest one.
   */
  let watchSequence = 0;
  function compiled(summary = "when the invented readout lands") {
    watchSequence += 1;
    return {
      plan: {
        version: 5 as const,
        predicate: {
          kind: "watch-v2" as const,
          watchId: `wat_fictional_${watchSequence}`,
          watchName: `fictional-readout-${watchSequence}`,
          evidence: "documents" as const,
          authoredBy: "integration" as const,
        },
      },
      interpretation: { summary, pushDetail: "existence" as const },
      compilerVersion: "watch-v2-anchor",
      privacyCategories: ["documents"],
    };
  }

  function serviceFor(
    decision: "allow" | "ask" | "deny",
    opts: {
      embedder?: "unavailable";
      review?: ReturnType<typeof vi.fn>;
      writeGate?: WriteGate;
      policyStore?: PrivacyPolicyStore;
    } = {},
  ): SubscriptionService {
    writeFileSync(
      join(configDir, PRIVACY_POLICY_FILENAME),
      "# Fictional privacy policy\n\nReview external disclosures.\n",
      { mode: 0o600 },
    );
    const review = opts.review ?? vi.fn(async () => policyReviewResult(decision));
    return new SubscriptionService({
      db,
      writeGate: opts.writeGate ?? directWriteGate(db),
      policyStore: opts.policyStore ?? new PrivacyPolicyStore(configDir),
      now: () => 1_000,
      id: () => `fictional-${++sequence}`,
      reviewWatchExistence: async (input) => {
        const result = await review(input);
        result.review.review.policyRevision = input.policyRevision;
        return result;
      },
    });
  }

  function grantsFor(subscriptionId: string) {
    return db
      .prepare<
        [string],
        {
          push_detail: string;
          categories_json: string;
          disclosure_categories_json: string;
          policy_revision: string;
        }
      >(
        `SELECT push_detail, categories_json, disclosure_categories_json, policy_revision
           FROM subscription_grants WHERE subscription_id = ? AND revoked_at IS NULL`,
      )
      .all(subscriptionId);
  }

  function approvalLedger(subscriptionId: string) {
    return db
      .prepare<[string], { status: string; revision: number }>(
        `SELECT status, revision FROM subscription_approvals
          WHERE subscription_id = ? ORDER BY revision`,
      )
      .all(subscriptionId);
  }

  function resolutionAudit(subscriptionId: string) {
    return db
      .prepare<[string], { display_json: string; payload_json: string }>(
        `SELECT display_json, payload_json FROM subscription_audit_events
          WHERE subscription_id = ? AND event_type = 'approval_resolved'
          ORDER BY sequence`,
      )
      .all(subscriptionId)
      .map((row) => ({
        display: JSON.parse(row.display_json) as { title: string; status: string | null },
        payload: JSON.parse(row.payload_json) as { approvalId: string; resolvedBy: string },
      }));
  }

  beforeEach(() => {
    db = new SqliteDatabase(":memory:");
    db.pragma("foreign_keys = ON");
    runSchemaSetup(db);
    deviceId = createDevice(db, {
      name: INTEGRATION_NAME,
      kind: "agent",
      capabilities: {
        agentIntegration: {
          harness: "openclaw",
          deliveryProtocolMin: 3,
          deliveryProtocolMax: 3,
          maxConcurrentRuns: 1,
          watchPrivacyPolicyVersion: 1,
        },
      },
    }).id;
    configDir = mkdtempSync(join(tmpdir(), "omnesis-watch-policy-"));
    sequence = 0;
  });

  afterEach(() => {
    db.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("names the policy family a watch was reviewed under, and says nothing when the store has none", async () => {
    // A store with a history db knows which family the document belongs to.
    const withFamilies = new PrivacyPolicyStore(configDir, { db, writeGate: directWriteGate(db) });
    const document = await withFamilies.get();
    expect(document.familyId).toBeTruthy();
    const review = vi.fn(async () => policyReviewResult("allow"));
    const service = serviceFor("allow", { review, policyStore: withFamilies });
    await service.create(
      { deviceId, tokenId: null },
      { condition: CONDITION, reaction: REACTION, idempotencyKey: "fictional-family-named" },
      compiled(),
    );
    expect(review).toHaveBeenCalledOnce();
    expect(review.mock.calls[0][0].policyFamily).toEqual({
      id: document.familyId,
      name: document.familyName,
    });

    // The file-only store carries no family; the review must not invent one.
    const fileOnlyReview = vi.fn(async () => policyReviewResult("allow"));
    const fileOnly = serviceFor("allow", { review: fileOnlyReview });
    await fileOnly.create(
      { deviceId, tokenId: null },
      { condition: CONDITION, reaction: REACTION, idempotencyKey: "fictional-family-unknown" },
      compiled(),
    );
    expect(fileOnlyReview).toHaveBeenCalledOnce();
    expect(fileOnlyReview.mock.calls[0][0]).not.toHaveProperty("policyFamily");
  });

  it("activates an allowed existence disclosure and mints an existence-only grant", async () => {
    const review = vi.fn(async () => policyReviewResult("allow"));
    const service = serviceFor("allow", { review });
    const caller = { deviceId, tokenId: null };

    const created = await service.create(
      caller,
      {
        condition: CONDITION,
        reaction: REACTION,
        idempotencyKey: "fictional-policy-allowed",
      },
      compiled(),
    );

    expect(created.status).toBe("active");
    expect(created.approval?.status).toBe("approved");
    expect(grantsFor(created.id)).toEqual([
      {
        push_detail: "existence",
        categories_json: JSON.stringify(["documents"]),
        disclosure_categories_json: JSON.stringify([
          { category: "schedule", detailLevel: "existence", subject: "user", count: 1 },
        ]),
        policy_revision: (await new PrivacyPolicyStore(configDir).get()).revision,
      },
    ]);
    expect(review).toHaveBeenCalledOnce();
    expect(
      db
        .prepare<
          [string],
          { privacy_review_json: string | null }
        >("SELECT privacy_review_json FROM subscription_approvals WHERE id = ?")
        .get(created.approval!.id)?.privacy_review_json,
    ).toContain("Synthetic policy decision");
  });

  it("attributes automatic activation to the privacy policy", async () => {
    const service = serviceFor("allow");
    const created = await service.create(
      { deviceId, tokenId: null },
      {
        condition: CONDITION,
        reaction: REACTION,
        idempotencyKey: "fictional-policy-attribution",
      },
      compiled(),
    );

    expect(
      db
        .prepare<
          [string],
          { resolved_by_device_id: string | null; resolved_by_token_id: string | null }
        >("SELECT resolved_by_device_id, resolved_by_token_id FROM subscription_approvals WHERE id = ?")
        .get(created.approval!.id),
    ).toEqual({ resolved_by_device_id: null, resolved_by_token_id: null });
    expect(resolutionAudit(created.id)).toEqual([
      {
        display: {
          title: "Watch allowed by your privacy policy",
          status: "approved",
        },
        payload: { approvalId: created.approval!.id, resolvedBy: "policy" },
      },
    ]);
  });

  it("still records a device tap as the device's own decision", async () => {
    const service = serviceFor("ask");
    const caller = { deviceId, tokenId: null };
    const created = await service.create(
      caller,
      {
        condition: CONDITION,
        reaction: REACTION,
        idempotencyKey: "fictional-policy-tap",
      },
      compiled(),
    );
    await service.resolveApproval(caller, created.approval!.id, "approve");

    expect(resolutionAudit(created.id)).toEqual([
      {
        display: { title: "Watch approved", status: "approved" },
        payload: { approvalId: created.approval!.id, resolvedBy: "device" },
      },
    ]);
    expect(
      db
        .prepare<
          [string],
          { resolved_by_device_id: string | null }
        >("SELECT resolved_by_device_id FROM subscription_approvals WHERE id = ?")
        .get(created.approval!.id),
    ).toEqual({ resolved_by_device_id: deviceId });
  });

  it("keeps the tap when the privacy policy requires approval", async () => {
    const service = serviceFor("ask");
    const created = await service.create(
      { deviceId, tokenId: null },
      {
        condition: CONDITION,
        reaction: REACTION,
        idempotencyKey: "fictional-policy-asks",
      },
      compiled(),
    );

    expect(created.status).toBe("pending_approval");
    expect(created.approval?.status).toBe("pending");
    expect(grantsFor(created.id)).toHaveLength(0);
    expect(resolutionAudit(created.id)).toHaveLength(0);
  });

  it("keeps legacy integrations pending until they advertise the new protocol", async () => {
    const legacyDeviceId = createDevice(db, {
      name: "Riverside legacy relay",
      kind: "agent",
      capabilities: {
        agentIntegration: {
          harness: "hermes",
          deliveryProtocolMin: 3,
          deliveryProtocolMax: 3,
          maxConcurrentRuns: 1,
        },
      },
    }).id;
    const review = vi.fn(async () => policyReviewResult("allow"));
    const service = serviceFor("allow", { review });
    const created = await service.create(
      { deviceId: legacyDeviceId, tokenId: null },
      {
        condition: CONDITION,
        reaction: REACTION,
        idempotencyKey: "fictional-policy-legacy-protocol",
      },
      compiled(),
    );
    expect(created.status).toBe("pending_approval");
    expect(review).not.toHaveBeenCalled();

    updateDeviceCapabilities(
      db,
      legacyDeviceId,
      {
        agentIntegration: {
          harness: "hermes",
          deliveryProtocolMin: 3,
          deliveryProtocolMax: 3,
          maxConcurrentRuns: 1,
          watchPrivacyPolicyVersion: 1,
        },
      },
      2_000,
    );
    await expect(service.reevaluatePendingWatchPolicies()).resolves.toBe(1);
    expect(service.get({ deviceId: legacyDeviceId, tokenId: null }, created.id).status).toBe(
      "active",
    );
    expect(review).toHaveBeenCalledOnce();
  });

  it("does not re-review a held watch on every drain while a legacy plugin is pending", async () => {
    const review = vi.fn(async () => policyReviewResult("ask"));
    const service = serviceFor("ask", { review });
    await service.create(
      { deviceId, tokenId: null },
      { condition: CONDITION, reaction: REACTION, idempotencyKey: "fictional-policy-held-once" },
      compiled(),
    );
    const legacyDeviceId = createDevice(db, {
      name: "Northstar legacy helper",
      kind: "agent",
      capabilities: {
        agentIntegration: {
          harness: "openclaw",
          deliveryProtocolMin: 3,
          deliveryProtocolMax: 3,
          maxConcurrentRuns: 1,
        },
      },
    }).id;
    await service.create(
      { deviceId: legacyDeviceId, tokenId: null },
      { condition: CONDITION, reaction: REACTION, idempotencyKey: "fictional-policy-legacy-held" },
      compiled(),
    );

    await service.reevaluatePendingWatchPolicies();
    await service.reevaluatePendingWatchPolicies();
    expect(review).toHaveBeenCalledOnce();
  });

  it("denies a watch whose existence disclosure the policy denies", async () => {
    const service = serviceFor("deny");
    const created = await service.create(
      { deviceId, tokenId: null },
      { condition: CONDITION, reaction: REACTION, idempotencyKey: "fictional-policy-denies" },
      compiled(),
    );
    expect(created.status).toBe("denied");
    expect(created.approval?.status).toBe("denied");
    expect(grantsFor(created.id)).toHaveLength(0);
  });

  it("fails closed when the reviewer throws and heals the pending watch later", async () => {
    const review = vi
      .fn()
      .mockRejectedValueOnce(new Error("fictional reviewer outage"))
      .mockResolvedValue(policyReviewResult("allow"));
    const service = serviceFor("allow", { review });
    const caller = { deviceId, tokenId: null };
    const created = await service.create(
      caller,
      {
        condition: CONDITION,
        reaction: REACTION,
        idempotencyKey: "fictional-policy-reviewer-outage",
      },
      compiled(),
    );
    expect(created.status).toBe("pending_approval");
    await expect(service.reevaluatePendingWatchPolicies()).resolves.toBe(1);
    expect(service.get(caller, created.id).status).toBe("active");
  });

  it("does not re-review an idempotent create replay", async () => {
    const review = vi.fn(async () => policyReviewResult("allow"));
    const service = serviceFor("allow", { review });
    const caller = { deviceId, tokenId: null };
    const request = {
      condition: CONDITION,
      reaction: REACTION,
      idempotencyKey: "fictional-policy-replay",
    };
    await service.create(caller, request, compiled());
    await service.create(caller, request, compiled());
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("refuses to revise a definition rather than reviewing a rewrite", async () => {
    // A record's condition is a compiled watch. Nothing here can rewrite one,
    // and rewriting an approved record in place would have the ledger claim a
    // wake went out under words nobody agreed to. Asking again is how a
    // changed condition gets a record — and its own approval.
    const review = vi.fn(async () => policyReviewResult("allow"));
    const service = serviceFor("allow", { review });
    const caller = { deviceId, tokenId: null };
    const created = await service.create(
      caller,
      { condition: CONDITION, reaction: REACTION, idempotencyKey: "fictional-policy-revise" },
      compiled(),
    );

    await expect(
      service.update(caller, created.id, {
        expectedRevision: created.revision,
        condition: {
          kind: "natural-language",
          description: 'when a new document has title exactly "Fictional revised readout"',
        },
      }),
    ).rejects.toThrow(/cannot be revised/);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("reviews a reused workflow with its cumulative Answer disclosure", async () => {
    const review = vi.fn(async () => policyReviewResult("allow"));
    const service = serviceFor("allow", { review });
    const caller = { deviceId, tokenId: null };
    const first = await service.create(
      caller,
      {
        condition: CONDITION,
        reaction: REACTION,
        idempotencyKey: "fictional-policy-cumulative-first",
      },
      compiled(),
    );
    db.prepare(
      `UPDATE answer_workflow_disclosure
          SET revision = 2, released_turns = 2, released_characters = 40,
              categories_json = '[{"category":"health","detailLevel":"summary","subject":"user","count":2}]'
        WHERE workflow_id = ?`,
    ).run(first.workflowId);

    await service.create(
      caller,
      {
        condition: {
          kind: "natural-language",
          description: 'when a new document has title exactly "Fictional cumulative readout"',
        },
        reaction: REACTION,
        workflowId: first.workflowId,
        idempotencyKey: "fictional-policy-cumulative-second",
      },
      compiled(),
    );
    expect(review.mock.calls[1]?.[0]).toMatchObject({
      cumulativeDisclosure: {
        revision: 2,
        releasedTurns: 2,
        categories: [{ category: "health", count: 2 }],
      },
    });
  });

  it("does not report an approval as pending when something else already settled it", async () => {
    // The race the operator sees on an auto-approving policy: the grants
    // resolve while the review that would have asked about them is still
    // running, so the review arrives at a subscription already active. Both
    // are right. Reported as an approval left hanging it reads as a fault on a
    // subscription the operator finds active moments later.
    const direct = directWriteGate(db);
    let settledEarly = false;
    const writeGate: WriteGate = {
      ...direct,
      recordSubscriptionPrivacyReview: async (input) => {
        if (!settledEarly) {
          settledEarly = true;
          db.prepare(`UPDATE subscriptions SET status = 'active' WHERE id = ?`).run(
            input.subscriptionId,
          );
          db.prepare(
            `UPDATE subscription_approvals SET status = 'approved'
              WHERE subscription_id = ? AND status = 'pending'`,
          ).run(input.subscriptionId);
        }
        return direct.recordSubscriptionPrivacyReview(input);
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = serviceFor("allow", {
      review: vi.fn(async () => policyReviewResult("allow")),
      writeGate,
    });
    const caller = { deviceId, tokenId: null };

    const created = await service.create(
      caller,
      {
        condition: CONDITION,
        reaction: REACTION,
        idempotencyKey: "fictional-approval-settled-early",
      },
      compiled(),
    );

    const warnings = warn.mock.calls.map((call) => call.map(String).join(" "));
    warn.mockRestore();
    expect(service.get(caller, created.id).status).toBe("active");
    expect(
      warnings.filter((line) => line.includes("approval stays pending")),
      "an approval that was already settled was reported as still pending",
    ).toEqual([]);
  });

  it("atomically retries when cumulative disclosure changes at review commit", async () => {
    const direct = directWriteGate(db);
    let injectedDisclosure = false;
    const writeGate: WriteGate = {
      ...direct,
      recordSubscriptionPrivacyReview: async (input) => {
        if (!injectedDisclosure) {
          injectedDisclosure = true;
          db.prepare(
            `UPDATE answer_workflow_disclosure
                SET revision = revision + 1, released_turns = released_turns + 1
              WHERE workflow_id = (
                SELECT workflow_id FROM subscriptions WHERE id = ?
              )`,
          ).run(input.subscriptionId);
        }
        return direct.recordSubscriptionPrivacyReview(input);
      },
    };
    const review = vi.fn(async () => policyReviewResult("allow"));
    const service = serviceFor("allow", { review, writeGate });
    const caller = { deviceId, tokenId: null };

    const created = await service.create(
      caller,
      {
        condition: CONDITION,
        reaction: REACTION,
        idempotencyKey: "fictional-policy-disclosure-race",
      },
      compiled(),
    );
    expect(created.status).toBe("pending_approval");
    expect(
      db
        .prepare<
          [string],
          { privacy_review_json: string | null }
        >("SELECT privacy_review_json FROM subscription_approvals WHERE id = ?")
        .get(created.approval!.id)?.privacy_review_json,
    ).toBeNull();

    await expect(service.reevaluatePendingWatchPolicies()).resolves.toBe(1);
    expect(service.get(caller, created.id).status).toBe("active");
    expect(review).toHaveBeenCalledTimes(2);
    expect(review.mock.calls[1]?.[0]).toMatchObject({
      cumulativeDisclosure: { revision: 1, releasedTurns: 1 },
    });
  });

  it("re-reviews a live watch after a policy revision revokes its old grant", async () => {
    const review = vi.fn(async () => policyReviewResult("allow"));
    const service = serviceFor("allow", { review });
    const caller = { deviceId, tokenId: null };
    const created = await service.create(
      caller,
      {
        condition: CONDITION,
        reaction: REACTION,
        idempotencyKey: "fictional-policy-reconcile",
      },
      compiled(),
    );
    expect(created.status).toBe("active");

    const store = new PrivacyPolicyStore(configDir);
    const before = await store.get();
    const edited = await store.update(
      before.revision,
      (policy) => `${policy}\nReview repeated disclosures cumulatively.\n`,
    );
    if (!edited) throw new Error("expected policy update");
    await directWriteGate(db).reconcileSubscriptionsPolicy(edited.revision, 2_000);
    expect(service.get(caller, created.id).status).toBe("pending_approval");

    await expect(service.reevaluatePendingWatchPolicies()).resolves.toBe(1);
    expect(service.get(caller, created.id).status).toBe("active");
    expect(approvalLedger(created.id)).toEqual([
      { status: "approved", revision: 1 },
      { status: "approved", revision: 2 },
    ]);
    expect(review).toHaveBeenCalledTimes(2);
  });
});

/**
 * The revision → compile-run link: a compiled plan's ledger run id travels
 * from the compiler's result onto the revision row and out on the trusted
 * admin projection, so the portal can navigate "plan → what the compiler saw
 * and said". Revisions compiled without a recorder keep NULL.
 */
