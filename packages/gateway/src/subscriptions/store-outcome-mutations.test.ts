// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SCOPE_SUBSCRIPTIONS_ANSWER, SCOPE_SUBSCRIPTIONS_OUTCOME } from "@omnesis/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createToken } from "../data/repositories/TokenRepository.js";
import { runSchemaSetup } from "../data/schema.js";
import { createSubscription, resolveSubscriptionApproval } from "./store-mutations.js";
import { fireSubscription } from "./store-firing-mutations.js";
import { claimSubscriptionDeliveries } from "./store-delivery-mutations.js";
import {
  issueSubscriptionFiringOutcomeAuthority,
  recordSubscriptionFiringOutcome,
} from "./store-outcome-mutations.js";
import { listWorkflowOutcomesForFiringKeys } from "./store-queries.js";
import type { CreateSubscriptionMutation, WorkflowOutcomeStatus } from "./store-types.js";

const EVENT_KEY = "watch:invented:1:threshold";

describe("workflow outcome reporting", () => {
  let db: Database.Database;
  let deviceId: string;

  function subscriptionInput(): CreateSubscriptionMutation {
    return {
      id: "sub_meridian",
      integrationDeviceId: deviceId,
      ownerId: `device:${deviceId}`,
      workflowId: "wf_meridian",
      clientRequestId: "request-meridian",
      approvalId: "sapp_meridian",
      condition: {
        kind: "natural-language",
        description: "when the invented depot ledger crosses its threshold",
      },
      reaction: {
        kind: "agent-workflow",
        instruction: "Reconcile the depot ledger and file the discrepancy note.",
      },
      interpretation: {
        summary: "Invented depot ledger crossed its threshold",
        pushDetail: "existence",
      },
      compiledPlan: {
        version: 5,
        predicate: {
          kind: "watch-v2",
          watchId: "watch_meridian",
          watchName: "meridian-depot",
          evidence: "condition-only",
          authoredBy: "integration",
        },
      } as unknown as CreateSubscriptionMutation["compiledPlan"],
      compilerVersion: "test-watch-v2",
      privacyCategories: ["analytics:invented_depot"],
      policyRevision: "policy-a",
      requestFingerprint: "fingerprint-meridian",
      createdAt: 100,
      expiresAt: 900_000,
      approvalExpiresAt: 900_000,
      workflowName: "Meridian depot reconciliation",
      workflowPurpose: "Reconcile the depot ledger and file the discrepancy note.",
      createWorkflow: true,
      workflowExpiresAt: 900_000,
      grounding: undefined,
    } as CreateSubscriptionMutation;
  }

  /** Fire, claim, and mint an outcome authority — the state a woken run is in. */
  function wokenRun(): { firingId: string; tokenId: string } {
    expect(createSubscription(db, subscriptionInput()).outcome).toBe("created");
    expect(
      resolveSubscriptionApproval(db, {
        approvalId: "sapp_meridian",
        decision: "approve",
        resolvedBy: { kind: "device", deviceId, tokenId: null },
        policyRevision: "policy-a",
        grantId: "sgrant_meridian",
        grantExpiresAt: 900_000,
        resolvedAt: 200,
      }).outcome,
    ).toBe("resolved");
    expect(
      fireSubscription(db, {
        firingId: "sfiring_meridian",
        subscriptionId: "sub_meridian",
        revision: 1,
        indexEventKey: EVENT_KEY,
        evidenceDocumentIds: [],
        observation: { shortfall: 12 },
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
    if (!delivery) throw new Error("expected a claimed delivery");
    const token = createToken(
      db,
      deviceId as Parameters<typeof createToken>[1],
      [SCOPE_SUBSCRIPTIONS_OUTCOME],
      "invented-outcome",
      { ttlMs: 24 * 60 * 60_000 },
    );
    expect(
      issueSubscriptionFiringOutcomeAuthority(db, {
        id: "sfoa_meridian",
        deliveryId: delivery.id,
        tokenId: token.id,
        createdAt: 450,
        expiresAt: 86_400_450,
      }),
    ).toMatchObject({ outcome: "issued", firingId: "sfiring_meridian" });
    return { firingId: "sfiring_meridian", tokenId: token.id };
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runSchemaSetup(db);
    deviceId = createDevice(db, { name: "Invented integration", kind: "agent" }).id;
  });

  afterEach(() => db.close());

  it("records what the run reported and reads it back beside the firing", () => {
    const { firingId, tokenId } = wokenRun();
    expect(
      recordSubscriptionFiringOutcome(db, {
        tokenId,
        firingId,
        status: "completed",
        report: "Filed the discrepancy note against the depot ledger.",
        reportedAt: 5_000,
      }),
    ).toMatchObject({ outcome: "recorded", runs: 1 });
    const found = listWorkflowOutcomesForFiringKeys(db, [EVENT_KEY]);
    expect(found.get(EVENT_KEY)).toMatchObject({
      firingId,
      outcome: {
        status: "completed",
        report: "Filed the discrepancy note against the depot ledger.",
        reportedAt: 5_000,
      },
    });
  });

  it("lets a resumed run supersede its own deferred report", () => {
    const { firingId, tokenId } = wokenRun();
    recordSubscriptionFiringOutcome(db, {
      tokenId,
      firingId,
      status: "deferred",
      report: "Waiting on the held answer.",
      reportedAt: 5_000,
    });
    expect(
      recordSubscriptionFiringOutcome(db, {
        tokenId,
        firingId,
        status: "completed",
        report: "Resumed after approval and filed the note.",
        reportedAt: 90_000,
      }),
    ).toMatchObject({ outcome: "recorded", runs: 2 });
    const stored = db
      .prepare<
        [string],
        { status: string; runs: number; first_reported_at: number }
      >("SELECT status, runs, first_reported_at FROM subscription_firing_outcomes WHERE firing_id = ?")
      .get(firingId);
    // The later word stands, and the earlier one stays legible as a run.
    expect(stored).toMatchObject({ status: "completed", runs: 2, first_reported_at: 5_000 });
  });

  it("distinguishes a firing that reported nothing from one that was never woken", () => {
    const { firingId } = wokenRun();
    const found = listWorkflowOutcomesForFiringKeys(db, [EVENT_KEY, "watch:invented:9:never"]);
    expect(found.get(EVENT_KEY)).toMatchObject({ firingId, outcome: null });
    expect(found.has("watch:invented:9:never")).toBe(false);
  });

  it("refuses a report from a token bound to no firing", () => {
    const { firingId } = wokenRun();
    const stranger = createToken(
      db,
      deviceId as Parameters<typeof createToken>[1],
      [SCOPE_SUBSCRIPTIONS_OUTCOME],
      "invented-stranger",
      { ttlMs: 60_000 },
    );
    expect(
      recordSubscriptionFiringOutcome(db, {
        tokenId: stranger.id,
        firingId,
        status: "completed",
        reportedAt: 5_000,
      }),
    ).toMatchObject({ outcome: "not_found" });
  });

  it("refuses a report once the authority's window has closed", () => {
    const { firingId, tokenId } = wokenRun();
    expect(
      recordSubscriptionFiringOutcome(db, {
        tokenId,
        firingId,
        status: "completed",
        reportedAt: 86_400_451,
      }),
    ).toMatchObject({ outcome: "expired" });
  });

  it("refuses to issue an authority over a token that could also answer", () => {
    expect(createSubscription(db, subscriptionInput()).outcome).toBe("created");
    resolveSubscriptionApproval(db, {
      approvalId: "sapp_meridian",
      decision: "approve",
      resolvedBy: { kind: "device", deviceId, tokenId: null },
      policyRevision: "policy-a",
      grantId: "sgrant_meridian",
      grantExpiresAt: 900_000,
      resolvedAt: 200,
    });
    fireSubscription(db, {
      firingId: "sfiring_meridian",
      subscriptionId: "sub_meridian",
      revision: 1,
      indexEventKey: EVENT_KEY,
      evidenceDocumentIds: [],
      policyRevision: "policy-a",
      firedAt: 300,
    });
    const [delivery] = claimSubscriptionDeliveries(db, {
      claimedAt: 400,
      policyRevision: "policy-a",
      limit: 1,
      leaseMs: 1_000,
      maxAttempts: 3,
    });
    if (!delivery) throw new Error("expected a claimed delivery");
    // A lost report must not double as an authority to read the corpus.
    const overreaching = createToken(
      db,
      deviceId as Parameters<typeof createToken>[1],
      [SCOPE_SUBSCRIPTIONS_OUTCOME, SCOPE_SUBSCRIPTIONS_ANSWER],
      "invented-overreaching",
      { ttlMs: 24 * 60 * 60_000 },
    );
    expect(
      issueSubscriptionFiringOutcomeAuthority(db, {
        id: "sfoa_overreaching",
        deliveryId: delivery.id,
        tokenId: overreaching.id,
        createdAt: 450,
        expiresAt: 86_400_450,
      }),
    ).toMatchObject({ outcome: "token_unavailable" });
  });
});

describe("the outcome vocabulary, wherever it is written down", () => {
  // Four hand-written copies: the SQL CHECK that refuses a row, the zod enum
  // that refuses a request, the TypeScript union the service is typed on, and
  // the plugin protocol. A status one of them knows and another does not is a
  // report that passes validation and then fails to store, or the reverse.
  const STATUSES = ["completed", "nothing_to_do", "failed", "deferred"] as const;

  it("is the same set in the schema, the request body, and the service type", () => {
    const schemaSource = readFileSync(
      fileURLToPath(new URL("./store-schema.ts", import.meta.url)),
      "utf8",
    );
    // Anchored on the outcome table: several tables in this file constrain a
    // column called status, and matching the first one would test a different
    // vocabulary while looking green.
    const outcomeTable =
      /CREATE TABLE IF NOT EXISTS subscription_firing_outcomes \(([\s\S]*?)\);/.exec(
        schemaSource,
      )?.[1];
    if (!outcomeTable) throw new Error("the outcome table is not declared");
    const check = /CHECK \(status IN \(([^)]*)\)\)/.exec(outcomeTable);
    if (!check) throw new Error("the outcome table declares no status CHECK");
    const constrained = [...check[1]!.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
    expect(constrained.sort()).toEqual([...STATUSES].sort());

    const bodySource = readFileSync(
      fileURLToPath(new URL("../http/schemas/subscriptions.ts", import.meta.url)),
      "utf8",
    );
    const outcomeBody = /subscriptionFiringOutcomeSchema = z([\s\S]*?)\.strict\(\);/.exec(
      bodySource,
    )?.[1];
    if (!outcomeBody) throw new Error("the outcome body schema is not declared");
    const accepted = /status: z\.enum\(\[([^\]]*)\]\)/.exec(outcomeBody);
    if (!accepted) throw new Error("the outcome body declares no status enum");
    expect([...accepted[1]!.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!).sort()).toEqual(
      [...STATUSES].sort(),
    );

    // Typed rather than scraped: this fails to compile if the union drifts.
    const everyStatus: Record<WorkflowOutcomeStatus, true> = {
      completed: true,
      nothing_to_do: true,
      failed: true,
      deferred: true,
    };
    expect(Object.keys(everyStatus).sort()).toEqual([...STATUSES].sort());
  });
});
