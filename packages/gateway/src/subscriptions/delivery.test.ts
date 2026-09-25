// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { createLogger, type WsRequestPayload } from "@omnesis/core";
import {
  SCOPE_SUBSCRIPTIONS_ANSWER,
  SCOPE_SUBSCRIPTIONS_OUTCOME,
  SCOPE_SUBSCRIPTIONS_RECEIVE,
  type DeviceId,
  type Scope,
} from "@omnesis/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDevice,
  createDevice,
  updateDeviceCapabilities,
} from "../data/repositories/DeviceRepository.js";
import { lookupToken } from "../data/repositories/TokenRepository.js";
import { runSchemaSetup } from "../data/schema.js";
import { directWriteGate } from "../write-gate.js";
import {
  createSubscription,
  fireSubscription,
  resolveSubscriptionApproval,
} from "./store-mutations.js";
import { validateSubscriptionFiringAnswerAuthority } from "./store-queries.js";
import {
  SubscriptionDeliveryService,
  subscriptionDeliveryBackoffMs,
  type SubscriptionDeliveryTransport,
} from "./delivery.js";
import type { CreateSubscriptionMutation } from "./store-types.js";

describe("SubscriptionDeliveryService", () => {
  let db: Database.Database;
  let deviceId: DeviceId;
  let now: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runSchemaSetup(db);
    deviceId = createDevice(db, {
      name: "Fictional OpenClaw integration",
      kind: "agent",
      capabilities: {
        agentIntegration: {
          harness: "openclaw",
          deliveryProtocolMin: 3,
          deliveryProtocolMax: 3,
          maxConcurrentRuns: 2,
        },
      },
    }).id;
    now = 400;
    createApprovedFiring();
  });

  afterEach(() => db.close());

  function createInput(): CreateSubscriptionMutation {
    // The plan shape the engine writes. It matters here beyond realism: the
    // evidence rule is read from it, and a firing in these tests carries
    // documents.
    const plan = {
      version: 5 as const,
      predicate: {
        kind: "watch-v2" as const,
        watchId: "wat_fictional_launch",
        watchName: "fictional-launch-ready",
        evidence: "documents" as const,
        authoredBy: "integration" as const,
      },
    };
    return {
      id: "sub_fictional_launch",
      approvalId: "sapp_fictional_launch",
      workflowId: "wf_fictional_launch",
      integrationDeviceId: deviceId,
      ownerId: `device:${deviceId}`,
      clientRequestId: "request-fictional-launch",
      requestFingerprint: "fingerprint-fictional-launch",
      condition: {
        kind: "natural-language",
        description: 'when a new document has title exactly "Fictional launch ready"',
      },
      reaction: {
        kind: "agent-workflow",
        instruction: "Prepare a fictional launch checklist.",
      },
      interpretation: {
        summary: "A new document has the requested fictional title",
        pushDetail: "existence",
      },
      compiledPlan: plan,
      compilerVersion: "test-v1",
      privacyCategories: ["documents"],
      policyRevision: "policy-a",
      createdAt: 100,
      expiresAt: 10_000,
      approvalExpiresAt: 2_000,
      workflowName: "Fictional launch subscription",
      workflowPurpose: "Prepare a fictional launch checklist.",
      createWorkflow: true,
      workflowExpiresAt: 10_000,
    };
  }

  function createApprovedFiring(): void {
    db.prepare(
      `INSERT INTO documents
         (id, provider_id, source_id, external_id, title, content, content_hash,
          source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES ('doc_fictional_launch', 'fictional', 'fictional:source',
               'external-fictional-launch', 'Fictional launch ready',
               'A wholly fictional launch record.', 'hash-fictional-launch',
               '2026-02-03T04:05:06Z', '2026-02-03T04:05:06Z',
               '2026-02-03T04:05:06Z', '2026-02-03T04:05:06Z')`,
    ).run();
    expect(createSubscription(db, createInput()).outcome).toBe("created");
    expect(
      resolveSubscriptionApproval(db, {
        approvalId: "sapp_fictional_launch",
        decision: "approve",
        resolvedBy: { kind: "device", deviceId, tokenId: null },
        policyRevision: "policy-a",
        grantId: "sgrant_fictional_launch",
        grantExpiresAt: 9_000,
        resolvedAt: 200,
      }).outcome,
    ).toBe("resolved");
    expect(
      fireSubscription(db, {
        firingId: "sfiring_fictional_launch",
        subscriptionId: "sub_fictional_launch",
        revision: 1,
        indexEventKey: "document:created:fictional",
        evidenceDocumentIds: ["doc_fictional_launch"],
        policyRevision: "policy-a",
        firedAt: 300,
      }).outcome,
    ).toBe("fired");
  }

  function transport(
    send: SubscriptionDeliveryTransport["sendCommand"],
    connected = true,
  ): SubscriptionDeliveryTransport {
    return {
      isConnected: vi.fn(() => connected),
      sendCommand: vi.fn(send),
    };
  }

  function service(
    deliveryTransport: SubscriptionDeliveryTransport,
    overrides: ConstructorParameters<typeof SubscriptionDeliveryService>[0]["config"] = {},
  ): SubscriptionDeliveryService {
    let authoritySequence = 0;
    return new SubscriptionDeliveryService({
      writeGate: directWriteGate(db),
      transport: deliveryTransport,
      getDevice: (id) => getDevice(db, id),
      policyStore: {
        path: "",
        get: async () => ({ policy: "fictional", revision: "policy-a", updatedAt: 0 }),
        runIfRevision: async (_expected, operation) => operation(),
      },
      log: createLogger("gateway:test:subscription-delivery"),
      now: () => now,
      id: () => `authority-fictional-${++authoritySequence}`,
      config: {
        answerAuthorityTtlMs: 1_000,
        baseBackoffMs: 1_000,
        maxBackoffMs: 8_000,
        leaseMs: 500,
        ...overrides,
      },
    });
  }

  it("speaks the newer wake only to an integration that understands it", async () => {
    // Same firing, a plugin that advertises the wider range. It gains the
    // author's referents and somewhere to report what its run did; the test
    // above, on a plugin that advertises only the older version, proves it
    // keeps receiving exactly what it did before.
    db.prepare("UPDATE devices SET capabilities = ? WHERE id = ?").run(
      JSON.stringify({
        agentIntegration: {
          harness: "openclaw",
          deliveryProtocolMin: 3,
          deliveryProtocolMax: 4,
          maxConcurrentRuns: 2,
        },
      }),
      deviceId,
    );
    db.prepare("UPDATE subscription_revisions SET reaction_json = ? WHERE subscription_id = ?").run(
      JSON.stringify({
        kind: "agent-workflow",
        instruction: "Prepare a fictional launch checklist.",
        bindings: { channel: "invented-channel-4271", contact: "casey@example.org" },
      }),
      "sub_fictional_launch",
    );

    let payload: WsRequestPayload<"subscription.prepare"> | undefined;
    const tx = transport(async (_deviceId, type, sent) => {
      if (type === "subscription.prepare") {
        payload = sent;
        return { status: "prepared", preparedAt: 405, duplicate: false };
      }
      return {
        status: "accepted",
        acceptedAt: 410,
        localRunId: "openclaw-run-fictional",
        duplicate: false,
      };
    });
    await expect(service(tx).drainOnce()).resolves.toMatchObject({ delivered: 1 });

    expect(payload).toMatchObject({
      protocolVersion: 4,
      reaction: {
        instruction: "Prepare a fictional launch checklist.",
        bindings: { channel: "invented-channel-4271", contact: "casey@example.org" },
      },
      outcome: { endpoint: "/subscriptions/firings/sfiring_fictional_launch/outcome" },
    });
    if (!payload || !("outcome" in payload)) throw new Error("expected an outcome authority");
    // Its own credential, and only its own capability: a report that leaked
    // must not double as an authority to read the corpus.
    const outcomeToken = lookupToken(db, payload.outcome.token);
    expect(outcomeToken?.scopes).toEqual([SCOPE_SUBSCRIPTIONS_OUTCOME]);
    expect(payload.outcome.token).not.toBe(payload.answer.token);
    // Long enough to outlive an answer held for the operator's approval.
    expect(payload.outcome.expiresAt).toBeGreaterThan(payload.answer.expiresAt);
    expect(JSON.stringify(payload)).not.toContain("doc_fictional_launch");
  });

  it("delivers only identifiers plus the subscriber-authored reaction and a firing token", async () => {
    let payload: WsRequestPayload<"subscription.prepare"> | undefined;
    let requiredScope: Scope | undefined;
    let prepareStageAnswerOutcome: string | undefined;
    const tx = transport(async (_deviceId, type, sent, _timeout, scope) => {
      requiredScope = scope;
      if (type === "subscription.prepare") {
        payload = sent;
        const token = lookupToken(db, sent.answer.token);
        prepareStageAnswerOutcome = validateSubscriptionFiringAnswerAuthority(db, {
          tokenId: token!.id,
          firingId: sent.firingId,
          policyRevision: "policy-a",
          now,
        }).outcome;
        return { status: "prepared", preparedAt: 405, duplicate: false };
      }
      return {
        status: "accepted",
        acceptedAt: 410,
        localRunId: "openclaw-run-fictional",
        duplicate: false,
      };
    });

    await expect(service(tx).drainOnce()).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      retrying: 0,
      failed: 0,
      stale: 0,
    });
    expect(requiredScope).toBe(SCOPE_SUBSCRIPTIONS_RECEIVE);
    expect(prepareStageAnswerOutcome).toBe("inactive");
    expect(payload).toMatchObject({
      protocolVersion: 3,
      deliveryId: "sdel_sfiring_fictional_launch",
      firingId: "sfiring_fictional_launch",
      subscriptionId: "sub_fictional_launch",
      workflowHandle: "wf_fictional_launch",
      reaction: { instruction: "Prepare a fictional launch checklist." },
      answer: {
        expiresAt: 1_400,
        endpoint: "/subscriptions/firings/sfiring_fictional_launch/answer",
      },
    });
    expect(Object.keys(payload ?? {}).sort()).toEqual([
      "answer",
      "deliveryId",
      "firingId",
      "protocolVersion",
      "reaction",
      "subscriptionId",
      "workflowHandle",
    ]);
    expect(JSON.stringify(payload)).not.toContain("doc_fictional_launch");
    expect(JSON.stringify(payload)).not.toContain("Fictional launch ready");

    const token = lookupToken(db, payload!.answer.token);
    expect(token?.scopes).toEqual([SCOPE_SUBSCRIPTIONS_ANSWER]);
    expect(
      db
        .prepare<
          [],
          { status: string; local_run_id: string }
        >("SELECT status, local_run_id FROM subscription_deliveries")
        .get(),
    ).toEqual({ status: "delivered", local_run_id: "openclaw-run-fictional" });
    expect(
      db
        .prepare<
          [],
          { raw_tokens: number }
        >("SELECT COUNT(*) AS raw_tokens FROM tokens WHERE token_hash = ?")
        .get(payload!.answer.token)?.raw_tokens,
    ).toBe(0);
  });

  it("keeps an offline integration queued without minting an answer token", async () => {
    const tx = transport(vi.fn(), false);
    await expect(service(tx).drainOnce()).resolves.toMatchObject({
      claimed: 1,
      retrying: 1,
    });
    expect(tx.sendCommand).not.toHaveBeenCalled();
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM tokens").get()!.count,
    ).toBe(0);
    expect(
      db
        .prepare<
          [],
          { status: string; next_attempt_at: number; attempts: number }
        >("SELECT status, next_attempt_at, attempts FROM subscription_deliveries")
        .get(),
    ).toEqual({ status: "retry", next_attempt_at: 1_400, attempts: 0 });
  });

  it("cancels a prepared wake when revocation wins the final authority check", async () => {
    const commands: string[] = [];
    const tx = transport(async (_deviceId, type) => {
      commands.push(type);
      if (type === "subscription.prepare") {
        return { status: "prepared", preparedAt: now, duplicate: false };
      }
      if (type === "subscription.cancel") {
        return { status: "cancelled", cancelledAt: now, duplicate: false };
      }
      throw new Error("commit must not be sent after revocation");
    });
    const writeGate = directWriteGate(db);
    const authorize = writeGate.authorizeSubscriptionDeliveryCommit.bind(writeGate);
    vi.spyOn(writeGate, "authorizeSubscriptionDeliveryCommit").mockImplementation(async (input) => {
      await writeGate.revokeSubscription({
        subscriptionId: "sub_fictional_launch",
        integrationDeviceId: deviceId,
        revokedAt: now,
      });
      return authorize(input);
    });
    const deliveryService = new SubscriptionDeliveryService({
      writeGate,
      transport: tx,
      getDevice: (id) => getDevice(db, id),
      policyStore: {
        path: "",
        get: async () => ({ policy: "fictional", revision: "policy-a", updatedAt: 0 }),
        runIfRevision: async (_expected, operation) => operation(),
      },
      log: createLogger("gateway:test:subscription-delivery-revoke-race"),
      now: () => now,
      id: () => "authority-revoke-race",
      config: { answerAuthorityTtlMs: 1_000 },
    });

    await expect(deliveryService.drainOnce()).resolves.toMatchObject({
      delivered: 0,
      failed: 1,
      stale: 0,
    });
    expect(commands).toEqual(["subscription.prepare", "subscription.cancel"]);
    expect(
      db.prepare<[], { status: string }>("SELECT status FROM subscriptions").get()?.status,
    ).toBe("revoked");
    expect(
      db.prepare<[], { status: string }>("SELECT status FROM subscription_deliveries").get()
        ?.status,
    ).toBe("failed");
    expect(
      db
        .prepare<[], { active: number }>(
          `SELECT COUNT(*) AS active
             FROM subscription_firing_answer_authorities
            WHERE revoked_at IS NULL`,
        )
        .get()?.active,
    ).toBe(0);
  });

  it("durably retries a revoke-time cancellation until the integration stores its tombstone", async () => {
    const commands: string[] = [];
    let cancellations = 0;
    const tx = transport(async (_deviceId, type) => {
      commands.push(type);
      if (type === "subscription.prepare") {
        return { status: "prepared", preparedAt: now, duplicate: false };
      }
      if (type === "subscription.cancel") {
        cancellations += 1;
        if (cancellations === 1) {
          throw new Error("fictional disconnect before cancellation acknowledgement");
        }
        return { status: "cancelled", cancelledAt: now, duplicate: true };
      }
      throw new Error("commit must not be sent after revocation");
    });
    const writeGate = directWriteGate(db);
    const authorize = writeGate.authorizeSubscriptionDeliveryCommit.bind(writeGate);
    vi.spyOn(writeGate, "authorizeSubscriptionDeliveryCommit").mockImplementation(async (input) => {
      await writeGate.revokeSubscription({
        subscriptionId: "sub_fictional_launch",
        integrationDeviceId: deviceId,
        revokedAt: now,
      });
      return authorize(input);
    });
    const deliveryService = new SubscriptionDeliveryService({
      writeGate,
      transport: tx,
      getDevice: (id) => getDevice(db, id),
      policyStore: {
        path: "",
        get: async () => ({ policy: "fictional", revision: "policy-a", updatedAt: 0 }),
        runIfRevision: async (_expected, operation) => operation(),
      },
      log: createLogger("gateway:test:subscription-delivery-durable-cancel"),
      now: () => now,
      id: () => "authority-durable-cancel",
      config: { baseBackoffMs: 1_000 },
    });

    await expect(deliveryService.drainOnce()).resolves.toMatchObject({ retrying: 1 });
    expect(
      db.prepare<[], { status: string }>("SELECT status FROM subscription_deliveries").get()
        ?.status,
    ).toBe("cancel_pending");
    now = 1_400;
    await expect(deliveryService.drainOnce()).resolves.toMatchObject({ failed: 1 });
    expect(commands).toEqual([
      "subscription.prepare",
      "subscription.cancel",
      "subscription.cancel",
    ]);
    expect(
      db.prepare<[], { status: string }>("SELECT status FROM subscription_deliveries").get()
        ?.status,
    ).toBe("failed");
  });

  it("cancels preparation when the privacy policy changes during the prepare round trip", async () => {
    let currentRevision = "policy-a";
    const commands: string[] = [];
    const tx = transport(async (_deviceId, type) => {
      commands.push(type);
      if (type === "subscription.prepare") {
        currentRevision = "policy-b";
        return { status: "prepared", preparedAt: now, duplicate: false };
      }
      if (type === "subscription.cancel") {
        return { status: "cancelled", cancelledAt: now, duplicate: false };
      }
      throw new Error("commit must not cross a superseded privacy policy");
    });
    const deliveryService = new SubscriptionDeliveryService({
      writeGate: directWriteGate(db),
      transport: tx,
      getDevice: (id) => getDevice(db, id),
      policyStore: {
        path: "",
        get: async () => ({
          policy: "fictional",
          revision: currentRevision,
          updatedAt: 0,
        }),
        runIfRevision: async (expected, operation) =>
          expected === currentRevision ? operation() : null,
      },
      log: createLogger("gateway:test:subscription-delivery-policy-race"),
      now: () => now,
      id: () => "authority-policy-race",
    });

    await expect(deliveryService.drainOnce()).resolves.toMatchObject({
      delivered: 0,
      retrying: 1,
    });
    expect(commands).toEqual(["subscription.prepare", "subscription.cancel"]);
    expect(
      db.prepare<[], { status: string }>("SELECT status FROM subscription_deliveries").get()
        ?.status,
    ).toBe("retry");
  });

  it("parks a device whose only socket lacks the receive scope without burning an attempt", async () => {
    const isConnected = vi.fn((_deviceId: DeviceId, requiredScope?: Scope) => !requiredScope);
    const tx: SubscriptionDeliveryTransport = {
      isConnected,
      sendCommand: vi.fn(),
    };

    await expect(service(tx).drainOnce()).resolves.toMatchObject({
      claimed: 1,
      retrying: 1,
    });

    expect(isConnected).toHaveBeenCalledWith(deviceId, SCOPE_SUBSCRIPTIONS_RECEIVE);
    expect(tx.sendCommand).not.toHaveBeenCalled();
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM tokens").get()!.count,
    ).toBe(0);
    expect(
      db
        .prepare<
          [],
          { status: string; attempts: number }
        >("SELECT status, attempts FROM subscription_deliveries")
        .get(),
    ).toEqual({ status: "retry", attempts: 0 });
  });

  it("is fully inert while the experimental feature is disabled", async () => {
    const writeGate = directWriteGate(db);
    const expire = vi.spyOn(writeGate, "expireSubscriptions");
    const reconcile = vi.spyOn(writeGate, "reconcileSubscriptionsPolicy");
    const claim = vi.spyOn(writeGate, "claimSubscriptionDeliveries");
    const policyGet = vi.fn(async () => ({
      policy: "fictional",
      revision: "policy-b",
      updatedAt: 0,
    }));
    const tx = transport(vi.fn());
    const deliveryService = new SubscriptionDeliveryService({
      writeGate,
      transport: tx,
      getDevice: (id) => getDevice(db, id),
      policyStore: {
        path: "",
        get: policyGet,
        runIfRevision: async (_expected, operation) => operation(),
      },
      log: createLogger("gateway:test:subscription-delivery-disabled"),
      now: () => now,
      isEnabled: () => false,
    });

    await expect(deliveryService.drainOnce()).resolves.toEqual({
      claimed: 0,
      delivered: 0,
      retrying: 0,
      failed: 0,
      stale: 0,
    });
    expect(policyGet).not.toHaveBeenCalled();
    expect(expire).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(tx.sendCommand).not.toHaveBeenCalled();
    expect(
      db.prepare<[], { status: string }>("SELECT status FROM subscriptions").get()?.status,
    ).toBe("active");
    expect(
      db.prepare<[], { status: string }>("SELECT status FROM subscription_deliveries").get()
        ?.status,
    ).toBe("pending");
  });

  it("replays only the stable commit after an ambiguous commit acknowledgement", async () => {
    const prepared: WsRequestPayload<"subscription.prepare">[] = [];
    const commits: WsRequestPayload<"subscription.commit">[] = [];
    const tx = transport(async (_deviceId, type, payload) => {
      if (type === "subscription.prepare") {
        prepared.push(payload);
        return { status: "prepared", preparedAt: now, duplicate: false };
      }
      if (type === "subscription.cancel") {
        return { status: "cancelled", cancelledAt: now, duplicate: false };
      }
      commits.push(payload);
      if (commits.length === 1) throw new Error("fictional connection reset after commit");
      return {
        status: "accepted",
        acceptedAt: now,
        localRunId: "openclaw-run-replayed",
        duplicate: true,
      };
    });
    const deliveryService = service(tx, { answerAuthorityTtlMs: 10_000 });

    await expect(deliveryService.drainOnce()).resolves.toMatchObject({ retrying: 1 });
    const token = lookupToken(db, prepared[0].answer.token);
    expect(
      validateSubscriptionFiringAnswerAuthority(db, {
        tokenId: token!.id,
        firingId: prepared[0].firingId,
        policyRevision: "policy-a",
        now,
      }).outcome,
    ).toBe("authorized");
    now = 1_400;
    await expect(deliveryService.drainOnce()).resolves.toMatchObject({ delivered: 1 });
    expect(prepared).toHaveLength(1);
    expect(commits).toHaveLength(2);
    expect(commits[0].deliveryId).toBe(commits[1].deliveryId);
    expect(commits[0].deliveryId).toBe(prepared[0].deliveryId);
    expect(lookupToken(db, prepared[0].answer.token)?.scopes).toEqual([SCOPE_SUBSCRIPTIONS_ANSWER]);
  });

  it("refreshes an expired Answer bearer before retrying an explicitly unreceived commit", async () => {
    const prepared: WsRequestPayload<"subscription.prepare">[] = [];
    let commits = 0;
    const tx = transport(async (_deviceId, type, payload) => {
      if (type === "subscription.prepare") {
        prepared.push(payload);
        return {
          status: "prepared",
          preparedAt: now,
          duplicate: prepared.length > 1,
        };
      }
      if (type === "subscription.cancel") {
        return { status: "cancelled", cancelledAt: now, duplicate: false };
      }
      commits += 1;
      if (commits === 1) {
        throw Object.assign(new Error("prepared Answer authority expired"), {
          code: "expired",
        });
      }
      return {
        status: "accepted",
        acceptedAt: now,
        localRunId: "openclaw-run-refreshed",
        duplicate: false,
      };
    });

    await expect(service(tx).drainOnce()).resolves.toMatchObject({ delivered: 1 });
    expect(prepared).toHaveLength(2);
    expect(prepared[1].deliveryId).toBe(prepared[0].deliveryId);
    expect(prepared[1].answer.token).not.toBe(prepared[0].answer.token);
    expect(
      db
        .prepare<[], { active: number; revoked: number }>(
          `SELECT
             SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked
           FROM subscription_firing_answer_authorities`,
        )
        .get(),
    ).toEqual({ active: 1, revoked: 1 });
  });

  it("parks an ambiguous native start for manual review without retry churn", async () => {
    let prepared: WsRequestPayload<"subscription.prepare"> | undefined;
    const tx = transport(async (_deviceId, type, payload) => {
      if (type === "subscription.prepare") {
        prepared = payload;
        return { status: "prepared", preparedAt: now, duplicate: false };
      }
      throw Object.assign(new Error("native start outcome is ambiguous"), {
        code: "ambiguous_start",
      });
    });
    const deliveryService = service(tx);

    await expect(deliveryService.drainOnce()).resolves.toMatchObject({
      delivered: 0,
      failed: 1,
      retrying: 0,
    });
    expect(
      db
        .prepare<
          [],
          { status: string; next_attempt_at: number | null }
        >("SELECT status, next_attempt_at FROM subscription_deliveries")
        .get(),
    ).toEqual({ status: "manual_review", next_attempt_at: null });
    const token = lookupToken(db, prepared!.answer.token);
    expect(
      validateSubscriptionFiringAnswerAuthority(db, {
        tokenId: token!.id,
        firingId: prepared!.firingId,
        policyRevision: "policy-a",
        now,
      }).outcome,
    ).toBe("authorized");
    now = 10_000;
    await expect(deliveryService.drainOnce()).resolves.toMatchObject({ claimed: 0 });
    expect(
      db
        .prepare<[], { count: number }>(
          `SELECT COUNT(*) AS count
             FROM subscription_audit_events
            WHERE event_type = 'delivery_manual_review'`,
        )
        .get()?.count,
    ).toBe(1);
  });

  it("terminalizes an explicit cancelled commit and revokes its Answer authority", async () => {
    const tx = transport(async (_deviceId, type) => {
      if (type === "subscription.prepare") {
        return { status: "prepared", preparedAt: now, duplicate: false };
      }
      throw Object.assign(new Error("delivery was cancelled before commit"), {
        code: "cancelled",
      });
    });

    await expect(service(tx).drainOnce()).resolves.toMatchObject({ failed: 1 });
    expect(
      db.prepare<[], { status: string }>("SELECT status FROM subscription_deliveries").get()
        ?.status,
    ).toBe("failed");
    expect(
      db
        .prepare<[], { active: number }>(
          `SELECT COUNT(*) AS active
             FROM subscription_firing_answer_authorities
            WHERE revoked_at IS NULL`,
        )
        .get()?.active,
    ).toBe(0);
  });

  it("fails closed when the current privacy policy no longer matches the grant", async () => {
    const tx = transport(async (_deviceId, type) => {
      if (type === "subscription.cancel") {
        return { status: "cancelled", cancelledAt: now, duplicate: false };
      }
      throw new Error(`unexpected ${type} command`);
    });
    const deliveryService = new SubscriptionDeliveryService({
      writeGate: directWriteGate(db),
      transport: tx,
      getDevice: (id) => getDevice(db, id),
      policyStore: {
        path: "",
        get: async () => ({ policy: "fictional", revision: "policy-b", updatedAt: 0 }),
        runIfRevision: async (_expected, operation) => operation(),
      },
      log: createLogger("gateway:test:subscription-delivery-policy"),
      now: () => now,
    });
    await expect(deliveryService.drainOnce()).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      retrying: 0,
      failed: 1,
      stale: 0,
    });
    expect(tx.sendCommand).toHaveBeenCalledWith(
      deviceId,
      "subscription.cancel",
      {
        protocolVersion: 3,
        deliveryId: "sdel_sfiring_fictional_launch",
      },
      expect.any(Number),
      SCOPE_SUBSCRIPTIONS_RECEIVE,
    );
    expect(
      db
        .prepare<
          [],
          { status: string; current_revision: number }
        >("SELECT status, current_revision FROM subscriptions")
        .get(),
    ).toEqual({ status: "pending_approval", current_revision: 2 });
    expect(
      db.prepare<[], { status: string }>("SELECT status FROM subscription_deliveries").get()
        ?.status,
    ).toBe("failed");
    expect(
      db.prepare<[], { status: string }>("SELECT status FROM subscription_firings").get()?.status,
    ).toBe("blocked");
  });

  it("terminalizes after the configured delivery attempt cap", async () => {
    const tx = transport(async (_deviceId, type) => {
      if (type === "subscription.cancel") {
        return { status: "cancelled", cancelledAt: now };
      }
      throw new Error("fictional integration unavailable");
    });
    const deliveryService = service(tx, { maxAttempts: 2 });
    await deliveryService.drainOnce();
    now = 1_400;
    await expect(deliveryService.drainOnce()).resolves.toMatchObject({ retrying: 1 });
    expect(
      db.prepare<[], { status: string }>("SELECT status FROM subscription_deliveries").get()
        ?.status,
    ).toBe("cancel_pending");
    await expect(deliveryService.drainOnce()).resolves.toMatchObject({ failed: 1 });
    expect(
      db
        .prepare<
          [],
          { status: string; attempts: number }
        >("SELECT status, attempts FROM subscription_deliveries")
        .get(),
    ).toEqual({ status: "failed", attempts: 3 });
  });

  it("honors per-device workflow concurrency across a full claimed burst", async () => {
    updateDeviceCapabilities(db, deviceId, {
      agentIntegration: {
        harness: "hermes",
        deliveryProtocolMin: 3,
        deliveryProtocolMax: 3,
        maxConcurrentRuns: 1,
      },
    });
    for (let index = 1; index < 16; index += 1) {
      expect(
        fireSubscription(db, {
          firingId: `sfiring_fictional_launch_${index}`,
          subscriptionId: "sub_fictional_launch",
          revision: 1,
          indexEventKey: `document:created:fictional:${index}`,
          evidenceDocumentIds: ["doc_fictional_launch"],
          policyRevision: "policy-a",
          firedAt: 300 + index,
        }).outcome,
      ).toBe("fired");
    }
    let active = 0;
    let peak = 0;
    const tx = transport(async (_deviceId, type, payload) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      if (type === "subscription.prepare") {
        return { status: "prepared", preparedAt: now, duplicate: false };
      }
      if (type === "subscription.cancel") {
        return { status: "cancelled", cancelledAt: now, duplicate: false };
      }
      return {
        status: "accepted",
        acceptedAt: now,
        localRunId: `hermes-${payload.deliveryId}`,
        duplicate: false,
      };
    });

    await expect(service(tx, { claimLimit: 16 }).drainOnce()).resolves.toEqual({
      claimed: 16,
      delivered: 16,
      retrying: 0,
      failed: 0,
      stale: 0,
    });
    expect(peak).toBe(1);
    expect(tx.sendCommand).toHaveBeenCalledTimes(32);
    expect(
      db
        .prepare<[], { status: string; attempts: number; count: number }>(
          `SELECT status, attempts, COUNT(*) AS count
             FROM subscription_deliveries
            GROUP BY status, attempts`,
        )
        .all(),
    ).toEqual([{ status: "delivered", attempts: 1, count: 16 }]);
  });

  it("retries an authorized commit without reverting its disclosure boundary", async () => {
    const busy = Object.assign(new Error("integration concurrency limit reached"), {
      code: "busy",
    });
    const tx = transport(async (_deviceId, type) => {
      if (type === "subscription.prepare") {
        return { status: "prepared", preparedAt: now, duplicate: false };
      }
      throw busy;
    });

    await expect(service(tx).drainOnce()).resolves.toMatchObject({
      claimed: 1,
      retrying: 1,
      failed: 0,
    });
    expect(
      db
        .prepare<
          [],
          { status: string; attempts: number; last_error: string }
        >("SELECT status, attempts, last_error FROM subscription_deliveries")
        .get(),
    ).toEqual({
      status: "commit_authorized",
      attempts: 1,
      last_error: "integration concurrency limit reached",
    });
  });

  it("does not apply the pre-commit attempt cap to a genuinely ambiguous commit", async () => {
    const tx = transport(async (_deviceId, type) => {
      if (type === "subscription.prepare") {
        return { status: "prepared", preparedAt: now, duplicate: false };
      }
      throw new Error("fictional connection lost after commit write");
    });
    const deliveryService = service(tx, { maxAttempts: 1 });

    await expect(deliveryService.drainOnce()).resolves.toMatchObject({ retrying: 1 });
    now = 1_400;
    await expect(deliveryService.drainOnce()).resolves.toMatchObject({ retrying: 1 });
    expect(
      db
        .prepare<
          [],
          { status: string; attempts: number }
        >("SELECT status, attempts FROM subscription_deliveries")
        .get(),
    ).toEqual({ status: "commit_authorized", attempts: 2 });
  });

  it("uses bounded exponential retry backoff", () => {
    const config = { baseBackoffMs: 1_000, maxBackoffMs: 3_000 };
    expect(subscriptionDeliveryBackoffMs(1, config)).toBe(1_000);
    expect(subscriptionDeliveryBackoffMs(2, config)).toBe(2_000);
    expect(subscriptionDeliveryBackoffMs(3, config)).toBe(3_000);
    expect(subscriptionDeliveryBackoffMs(20, config)).toBe(3_000);
  });
});
