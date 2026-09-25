// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Durable subscription wake delivery.
 *
 * A firing is committed together with an outbox row. Each drain pass leases
 * due rows, mints a fresh short-lived firing-bound Answer credential, and asks
 * the integration to durably prepare (but not execute) the wake. Only after a
 * second atomic privacy revalidation does the gateway commit execution. A
 * revoke that wins before that boundary is followed by a durable cancel
 * tombstone in the integration; a crash after it resumes only the idempotent
 * commit. The stable delivery id deduplicates the local workflow.
 */

import { randomUUID } from "node:crypto";
import { type Logger, type WsRequestPayload, type WsResponsePayload } from "@omnesis/core";
import {
  DeviceId,
  SCOPE_SUBSCRIPTIONS_ANSWER,
  SCOPE_SUBSCRIPTIONS_OUTCOME,
  SCOPE_SUBSCRIPTIONS_RECEIVE,
  type DeviceRecord,
  type Scope,
  type TokenId,
} from "@omnesis/types";
import type { WriteGate } from "../write-gate.js";
import type { PrivacyPolicyStore } from "../privacy/policy-store.js";
import type { ClaimedSubscriptionDelivery } from "./store-types.js";

/**
 * The delivery protocol range this gateway speaks.
 *
 * A harness host runs a plugin somebody installed once, so the two halves are
 * routinely different ages. Each wake is therefore built at the highest version
 * the receiving integration says it understands: a plugin that predates a field
 * keeps working without it rather than failing to parse the wake, and one that
 * understands it gets it without waiting for the other to be reinstalled.
 */
export const AGENT_INTEGRATION_DELIVERY_PROTOCOL_MIN_VERSION = 3 as const;
export const AGENT_INTEGRATION_DELIVERY_PROTOCOL_VERSION = 4 as const;

export type DeliveryProtocolVersion =
  | typeof AGENT_INTEGRATION_DELIVERY_PROTOCOL_MIN_VERSION
  | typeof AGENT_INTEGRATION_DELIVERY_PROTOCOL_VERSION;

/** The version to speak to this integration, or null when none is shared. */
export function negotiatedDeliveryProtocol(capability: {
  deliveryProtocolMin: number;
  deliveryProtocolMax: number;
}): DeliveryProtocolVersion | null {
  if (
    capability.deliveryProtocolMin > AGENT_INTEGRATION_DELIVERY_PROTOCOL_VERSION ||
    capability.deliveryProtocolMax < AGENT_INTEGRATION_DELIVERY_PROTOCOL_MIN_VERSION
  ) {
    return null;
  }
  return capability.deliveryProtocolMax >= AGENT_INTEGRATION_DELIVERY_PROTOCOL_VERSION
    ? AGENT_INTEGRATION_DELIVERY_PROTOCOL_VERSION
    : AGENT_INTEGRATION_DELIVERY_PROTOCOL_MIN_VERSION;
}

export interface SubscriptionDeliveryConfig {
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  claimLimit: number;
  leaseMs: number;
  commandTimeoutMs: number;
  answerAuthorityTtlMs: number;
  /**
   * Longer than the Answer authority beside it, and deliberately so. Nothing
   * leaves the sandbox through an outcome report, and the run it describes can
   * outlast every short-lived credential — a workflow whose answer waited on
   * the operator's approval finishes when they get to it.
   */
  outcomeAuthorityTtlMs: number;
}

export const DEFAULT_SUBSCRIPTION_DELIVERY_CONFIG: SubscriptionDeliveryConfig = {
  maxAttempts: 8,
  baseBackoffMs: 5_000,
  maxBackoffMs: 300_000,
  claimLimit: 16,
  leaseMs: 60_000,
  commandTimeoutMs: 30_000,
  answerAuthorityTtlMs: 30 * 60_000,
  outcomeAuthorityTtlMs: 24 * 60 * 60_000,
};

export interface SubscriptionDeliveryTransport {
  isConnected(deviceId: DeviceId, requiredScope?: Scope): boolean;
  sendCommand<K extends "subscription.prepare" | "subscription.commit" | "subscription.cancel">(
    deviceId: DeviceId,
    type: K,
    payload: WsRequestPayload<K>,
    timeoutMs?: number,
    requiredScope?: Scope,
  ): Promise<WsResponsePayload<K>>;
}

export interface SubscriptionDeliveryServiceDeps {
  writeGate: WriteGate;
  transport: SubscriptionDeliveryTransport;
  getDevice: (deviceId: DeviceId) => DeviceRecord | null;
  policyStore: Pick<PrivacyPolicyStore, "get" | "runIfRevision" | "path">;
  log: Logger;
  config?: Partial<SubscriptionDeliveryConfig>;
  now?: () => number;
  id?: () => string;
  /** Live experimental gate. Disabled delivery rows remain parked. */
  isEnabled?: () => boolean;
  /** Refresh the orchestrator snapshot after durable expiry disabled triggers. */
  onExpired?: () => void;
  /**
   * Re-evaluate pending compatible watches after a privacy-policy revision.
   */
  reevaluatePendingWatchPolicies?: () => Promise<number>;
  /**
   * Converge operator watches whose activation failed transiently (embedder
   * or analytics dependency down at create/update) to active. Runs each
   * drain pass, before claiming, so a healed watch can deliver in the same
   * pass. Cheap when nothing is pending.
   */
  reapplyOperatorApprovals?: () => Promise<number>;
}

export interface SubscriptionDeliveryDrainResult {
  claimed: number;
  delivered: number;
  retrying: number;
  failed: number;
  stale: number;
}

type DeliveryOutcome = "delivered" | "retry" | "failed" | "stale";
type CommitRefreshOutcome =
  | { kind: "refreshed" }
  | { kind: "retry"; error: string }
  | { kind: "permanent"; error: string; code: string };

export function subscriptionDeliveryBackoffMs(
  attempt: number,
  config: Pick<SubscriptionDeliveryConfig, "baseBackoffMs" | "maxBackoffMs">,
): number {
  return Math.min(config.maxBackoffMs, config.baseBackoffMs * 2 ** Math.max(0, attempt - 1));
}

function remoteCommandErrorCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return null;
}

function isPermanentIntegrationErrorCode(code: string | null): code is string {
  return (
    code === "cancelled" ||
    code === "delivery_conflict" ||
    code === "invalid_payload" ||
    code === "unsupported"
  );
}

export class SubscriptionDeliveryService {
  private readonly config: SubscriptionDeliveryConfig;
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly deps: SubscriptionDeliveryServiceDeps) {
    this.config = {
      maxAttempts: deps.config?.maxAttempts ?? DEFAULT_SUBSCRIPTION_DELIVERY_CONFIG.maxAttempts,
      baseBackoffMs:
        deps.config?.baseBackoffMs ?? DEFAULT_SUBSCRIPTION_DELIVERY_CONFIG.baseBackoffMs,
      maxBackoffMs: deps.config?.maxBackoffMs ?? DEFAULT_SUBSCRIPTION_DELIVERY_CONFIG.maxBackoffMs,
      claimLimit: deps.config?.claimLimit ?? DEFAULT_SUBSCRIPTION_DELIVERY_CONFIG.claimLimit,
      outcomeAuthorityTtlMs:
        deps.config?.outcomeAuthorityTtlMs ??
        DEFAULT_SUBSCRIPTION_DELIVERY_CONFIG.outcomeAuthorityTtlMs,
      leaseMs: deps.config?.leaseMs ?? DEFAULT_SUBSCRIPTION_DELIVERY_CONFIG.leaseMs,
      commandTimeoutMs:
        deps.config?.commandTimeoutMs ?? DEFAULT_SUBSCRIPTION_DELIVERY_CONFIG.commandTimeoutMs,
      answerAuthorityTtlMs:
        deps.config?.answerAuthorityTtlMs ??
        DEFAULT_SUBSCRIPTION_DELIVERY_CONFIG.answerAuthorityTtlMs,
    };
    this.now = deps.now ?? Date.now;
    this.id = deps.id ?? randomUUID;
  }

  async drainOnce(): Promise<SubscriptionDeliveryDrainResult> {
    if (this.deps.isEnabled && !this.deps.isEnabled()) {
      return { claimed: 0, delivered: 0, retrying: 0, failed: 0, stale: 0 };
    }
    const now = this.now();
    const policy = await this.deps.policyStore.get();
    const expired = await this.deps.writeGate.expireSubscriptions(now);
    const policyChanged = await this.deps.writeGate.reconcileSubscriptionsPolicy(
      policy.revision,
      now,
    );
    if (expired > 0 || policyChanged > 0) this.deps.onExpired?.();
    // Before claiming, so a watch the policy or the operator's own authority
    // just activated can deliver in this same pass
    // rather than waiting for the next one.
    await this.reevaluatePendingWatchPolicies();
    await this.reapplyOperatorApprovals();
    const claimed = await this.deps.writeGate.claimSubscriptionDeliveries({
      claimedAt: now,
      policyRevision: policy.revision,
      limit: this.config.claimLimit,
      leaseMs: this.config.leaseMs,
      maxAttempts: this.config.maxAttempts,
    });
    const outcomes = await this.deliverWithinDeviceCapacity(claimed, policy.revision);
    const result = {
      claimed: claimed.length,
      delivered: outcomes.filter((outcome) => outcome === "delivered").length,
      retrying: outcomes.filter((outcome) => outcome === "retry").length,
      failed: outcomes.filter((outcome) => outcome === "failed").length,
      stale: outcomes.filter((outcome) => outcome === "stale").length,
    };
    if (result.claimed > 0) {
      this.deps.log.info(
        `subscription delivery: claimed=${result.claimed} delivered=${result.delivered} retrying=${result.retrying} failed=${result.failed} stale=${result.stale}`,
      );
    }
    return result;
  }

  /**
   * Best-effort: a policy-review pass that fails must not stop this drain from
   * delivering the wakes that are already due.
   */
  private async reevaluatePendingWatchPolicies(): Promise<void> {
    const reapply = this.deps.reevaluatePendingWatchPolicies;
    if (!reapply) return;
    try {
      await reapply();
    } catch (error) {
      this.deps.log.warn(
        `pending watch privacy review failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Same best-effort contract as {@link reevaluatePendingWatchPolicies}. */
  private async reapplyOperatorApprovals(): Promise<void> {
    const reapply = this.deps.reapplyOperatorApprovals;
    if (!reapply) return;
    try {
      await reapply();
    } catch (error) {
      this.deps.log.warn(
        `operator watch re-approval pass failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * A device advertises the number of workflow starts it can accept at once.
   * Bound dispatch before the command crosses the socket so a gateway-created
   * burst never turns ordinary local capacity into retry attempts.
   */
  private async deliverWithinDeviceCapacity(
    claimed: ClaimedSubscriptionDelivery[],
    policyRevision: string,
  ): Promise<DeliveryOutcome[]> {
    const groups = new Map<string, ClaimedSubscriptionDelivery[]>();
    for (const delivery of claimed) {
      const group = groups.get(delivery.integrationDeviceId) ?? [];
      group.push(delivery);
      groups.set(delivery.integrationDeviceId, group);
    }
    const groupOutcomes = await Promise.all(
      [...groups.entries()].map(async ([rawDeviceId, deliveries]) => {
        let limit = 1;
        try {
          const device = this.deps.getDevice(DeviceId(rawDeviceId));
          limit = Math.max(1, device?.capabilities.agentIntegration?.maxConcurrentRuns ?? 1);
        } catch {
          // deliverOne records the invalid identifier as a durable failure.
        }
        const outcomes = new Array<DeliveryOutcome>(deliveries.length);
        let cursor = 0;
        const worker = async (): Promise<void> => {
          while (cursor < deliveries.length) {
            const index = cursor;
            cursor += 1;
            outcomes[index] = await this.deliverOne(deliveries[index]!, policyRevision);
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(limit, deliveries.length) }, () => worker()),
        );
        return outcomes;
      }),
    );
    return groupOutcomes.flat();
  }

  private async deliverOne(
    delivery: ClaimedSubscriptionDelivery,
    policyRevision: string,
  ): Promise<DeliveryOutcome> {
    let deviceId: DeviceId;
    try {
      deviceId = DeviceId(delivery.integrationDeviceId);
    } catch {
      return delivery.phase === "commit"
        ? this.finishCommitRetry(delivery, "integration device identifier is invalid")
        : delivery.phase === "cancel"
          ? this.finishCancelRetry(delivery, "integration device identifier is invalid")
          : this.finishFailure(delivery, "integration device identifier is invalid");
    }
    const device = this.deps.getDevice(deviceId);
    const capability = device?.capabilities.agentIntegration;
    if (
      !device ||
      device.kind !== "agent" ||
      !capability ||
      negotiatedDeliveryProtocol(capability) === null
    ) {
      const reason =
        "approved agent integration does not support the subscription delivery protocol";
      return delivery.phase === "commit"
        ? this.finishCommitRetry(delivery, reason)
        : delivery.phase === "cancel"
          ? this.finishCancelRetry(delivery, reason)
          : this.finishFailure(delivery, reason);
    }
    // Settled once per attempt and used for every frame of it, so a wake, its
    // commit and its cancellation are always spoken in one version.
    const protocolVersion = negotiatedDeliveryProtocol(capability)!;
    if (!this.deps.transport.isConnected(deviceId, SCOPE_SUBSCRIPTIONS_RECEIVE)) {
      return delivery.phase === "commit"
        ? this.finishCommitRetry(delivery, "agent integration is offline")
        : delivery.phase === "cancel"
          ? this.finishCancelRetry(delivery, "agent integration is offline")
          : this.parkOffline(delivery);
    }

    if (delivery.phase === "cancel") {
      return this.cancelPrepared(delivery, deviceId, protocolVersion);
    }

    if (delivery.phase === "commit") {
      return this.commitPrepared(delivery, deviceId, policyRevision, protocolVersion);
    }

    const issuedAt = this.now();
    const authorityExpiresAt = issuedAt + this.config.answerAuthorityTtlMs;
    let answerToken: Awaited<ReturnType<WriteGate["createToken"]>> | undefined;
    let outcomeTokenId: TokenId | undefined;
    let prepareMayHaveReachedIntegration = false;
    try {
      answerToken = await this.deps.writeGate.createToken(
        deviceId,
        [SCOPE_SUBSCRIPTIONS_ANSWER],
        "subscription-firing-answer",
        { ttlMs: this.config.answerAuthorityTtlMs },
      );
      const issued = await this.deps.writeGate.issueSubscriptionFiringAnswerAuthority({
        id: `sfaa_${this.id()}`,
        deliveryId: delivery.id,
        claimId: delivery.claimId,
        tokenId: answerToken.id,
        policyRevision,
        createdAt: issuedAt,
        expiresAt: authorityExpiresAt,
      });
      if (issued.outcome !== "issued") {
        await this.revokeBestEffort(answerToken.id);
        return this.finishFailure(
          delivery,
          `firing answer authority unavailable (${issued.outcome})`,
        );
      }

      const outcomeAuthority =
        protocolVersion >= AGENT_INTEGRATION_DELIVERY_PROTOCOL_VERSION
          ? await this.mintOutcomeAuthority(delivery, deviceId, issuedAt)
          : null;
      outcomeTokenId = outcomeAuthority?.tokenId;
      const payload = this.preparePayload(
        delivery,
        protocolVersion,
        { token: answerToken.token, expiresAt: issued.authority.expiresAt },
        outcomeAuthority,
      );
      // A transport rejection after this point cannot prove the integration
      // failed to durably stage the wake.
      prepareMayHaveReachedIntegration = true;
      await this.deps.transport.sendCommand(
        deviceId,
        "subscription.prepare",
        payload,
        this.config.commandTimeoutMs,
        SCOPE_SUBSCRIPTIONS_RECEIVE,
      );
      const authorized =
        (await this.deps.policyStore.runIfRevision(policyRevision, () =>
          this.deps.writeGate.authorizeSubscriptionDeliveryCommit({
            deliveryId: delivery.id,
            claimId: delivery.claimId,
            policyRevision,
            ...(this.deps.policyStore.path
              ? {
                  policyGuard: {
                    path: this.deps.policyStore.path,
                    expectedRevision: policyRevision,
                  },
                }
              : {}),
            authorizedAt: this.now(),
          }),
        )) ?? ({ outcome: "policy_changed" } as const);
      if (authorized.outcome !== "authorized") {
        await this.revokeBestEffort(answerToken.id);
        // The wake is being withdrawn, so the authority to report on it goes
        // with it: an outcome filed against a cancelled delivery would say a
        // workflow ran that never started.
        if (outcomeTokenId) await this.revokeBestEffort(outcomeTokenId);
        const cancellation = await this.cancelPrepared(delivery, deviceId, protocolVersion);
        if (cancellation !== "stale") return cancellation;
        return this.finishFailure(
          delivery,
          `subscription authority changed before commit (${authorized.outcome})`,
        );
      }
      return this.commitPrepared(delivery, deviceId, policyRevision, protocolVersion);
    } catch (err) {
      if (answerToken) await this.revokeBestEffort(answerToken.id);
      if (outcomeTokenId) await this.revokeBestEffort(outcomeTokenId);
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code?: unknown }).code === "busy"
      ) {
        return this.parkCapacity(delivery);
      }
      return this.finishFailure(
        delivery,
        err instanceof Error ? err.message : String(err),
        prepareMayHaveReachedIntegration,
      );
    }
  }

  private async commitPrepared(
    delivery: ClaimedSubscriptionDelivery,
    deviceId: DeviceId,
    policyRevision: string,
    protocolVersion: DeliveryProtocolVersion,
    allowRefresh = true,
  ): Promise<DeliveryOutcome> {
    try {
      const response = await this.deps.transport.sendCommand(
        deviceId,
        "subscription.commit",
        {
          protocolVersion,
          deliveryId: delivery.id,
        },
        this.config.commandTimeoutMs,
        SCOPE_SUBSCRIPTIONS_RECEIVE,
      );
      const settled = await this.deps.writeGate.settleSubscriptionDelivery({
        deliveryId: delivery.id,
        claimId: delivery.claimId,
        settledAt: this.now(),
        outcome: {
          kind: "delivered",
          acceptedAt: response.acceptedAt,
          localRunId: response.localRunId,
        },
      });
      if (settled.outcome !== "settled") {
        this.deps.log.warn(`subscription commit ${delivery.id} acknowledged under a stale claim`);
        return "stale";
      }
      return "delivered";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = remoteCommandErrorCode(err);
      if (code === "ambiguous_start") {
        return this.finishCommitManualReview(delivery, message);
      }
      if (isPermanentIntegrationErrorCode(code)) {
        return this.finishCommitPermanentFailure(delivery, message, code);
      }
      if (code === "expired" || code === "not_prepared") {
        if (!allowRefresh) {
          return this.finishCommitPermanentFailure(delivery, message, code);
        }
        const refreshed = await this.refreshCommitPreparation(
          delivery,
          deviceId,
          policyRevision,
          protocolVersion,
        );
        if (refreshed.kind === "retry") {
          return this.finishCommitRetry(delivery, refreshed.error);
        }
        if (refreshed.kind === "permanent") {
          return this.finishCommitPermanentFailure(delivery, refreshed.error, refreshed.code);
        }
        return this.commitPrepared(delivery, deviceId, policyRevision, protocolVersion, false);
      }
      return this.finishCommitRetry(delivery, message);
    }
  }

  private async refreshCommitPreparation(
    delivery: ClaimedSubscriptionDelivery,
    deviceId: DeviceId,
    policyRevision: string,
    protocolVersion: DeliveryProtocolVersion,
  ): Promise<CommitRefreshOutcome> {
    const issuedAt = this.now();
    let answerToken: Awaited<ReturnType<WriteGate["createToken"]>> | undefined;
    try {
      answerToken = await this.deps.writeGate.createToken(
        deviceId,
        [SCOPE_SUBSCRIPTIONS_ANSWER],
        "subscription-firing-answer",
        { ttlMs: this.config.answerAuthorityTtlMs },
      );
      const issued =
        (await this.deps.policyStore.runIfRevision(policyRevision, () =>
          this.deps.writeGate.issueSubscriptionFiringAnswerAuthority({
            id: `sfaa_${this.id()}`,
            deliveryId: delivery.id,
            claimId: delivery.claimId,
            tokenId: answerToken!.id,
            policyRevision,
            phase: "commit_refresh",
            ...(this.deps.policyStore.path
              ? {
                  policyGuard: {
                    path: this.deps.policyStore.path,
                    expectedRevision: policyRevision,
                  },
                }
              : {}),
            createdAt: issuedAt,
            expiresAt: issuedAt + this.config.answerAuthorityTtlMs,
          }),
        )) ?? ({ outcome: "policy_changed" } as const);
      if (issued.outcome !== "issued") {
        await this.revokeBestEffort(answerToken.id);
        return {
          kind: "permanent",
          code: issued.outcome,
          error: `commit-authorized Answer authority could not be refreshed (${issued.outcome})`,
        };
      }
      await this.deps.transport.sendCommand(
        deviceId,
        "subscription.prepare",
        this.preparePayload(
          delivery,
          protocolVersion,
          { token: answerToken.token, expiresAt: issued.authority.expiresAt },
          protocolVersion >= 4
            ? await this.mintOutcomeAuthority(delivery, deviceId, issuedAt)
            : null,
        ),
        this.config.commandTimeoutMs,
        SCOPE_SUBSCRIPTIONS_RECEIVE,
      );
      return { kind: "refreshed" };
    } catch (error) {
      if (answerToken) await this.revokeBestEffort(answerToken.id);
      const code = remoteCommandErrorCode(error);
      const message = error instanceof Error ? error.message : String(error);
      if (isPermanentIntegrationErrorCode(code) || code === "expired") {
        return { kind: "permanent", code, error: message };
      }
      return { kind: "retry", error: message };
    }
  }

  private preparePayload(
    delivery: ClaimedSubscriptionDelivery,
    protocolVersion: DeliveryProtocolVersion,
    answer: { token: string; expiresAt: number },
    outcome: { token: string; expiresAt: number } | null,
  ): WsRequestPayload<"subscription.prepare"> {
    if (delivery.reaction.kind !== "agent-workflow") {
      // The only reaction this drain delivers. A watch that notifies the
      // operator's own phones is sent by the engine's push transport and never
      // becomes a delivery row, so one arriving here is a programming error
      // rather than something to wake an agent about.
      throw new Error("subscription wake prepared for a non-workflow reaction");
    }
    const answerAuthority = {
      token: answer.token,
      expiresAt: answer.expiresAt,
      endpoint: `/subscriptions/firings/${delivery.firingId}/answer`,
    };
    const identifiers = {
      deliveryId: delivery.id,
      firingId: delivery.firingId,
      subscriptionId: delivery.subscriptionId,
      workflowHandle: delivery.workflowId,
    };
    if (protocolVersion < AGENT_INTEGRATION_DELIVERY_PROTOCOL_VERSION) {
      // Nothing this integration has not asked for: a plugin that predates the
      // bindings refuses to parse a wake carrying them. The version decides
      // this and nothing else — a missing outcome authority is a missing
      // receipt, not a reason to speak an older dialect and drop the
      // referents the workflow needs along with it.
      return {
        protocolVersion: AGENT_INTEGRATION_DELIVERY_PROTOCOL_MIN_VERSION,
        ...identifiers,
        reaction: { instruction: delivery.reaction.instruction },
        answer: answerAuthority,
      };
    }
    const bindings = delivery.reaction.bindings;
    return {
      protocolVersion: AGENT_INTEGRATION_DELIVERY_PROTOCOL_VERSION,
      ...identifiers,
      reaction: {
        instruction: delivery.reaction.instruction,
        // Absent rather than empty when the author bound nothing: the wake's
        // identity hash covers every field it carries, so an empty map would
        // make two otherwise identical wakes differ.
        ...(bindings && Object.keys(bindings).length > 0 ? { bindings } : {}),
      },
      answer: answerAuthority,
      ...(outcome
        ? {
            outcome: {
              token: outcome.token,
              expiresAt: outcome.expiresAt,
              endpoint: `/subscriptions/firings/${delivery.firingId}/outcome`,
            },
          }
        : {}),
    };
  }

  /**
   * Mint the authority a woken run reports its outcome through.
   *
   * Best effort by design: a wake that cannot carry one is still a wake, and
   * refusing to deliver the workflow because its report could not be
   * authorized would trade a missing receipt for missing work. The failure is
   * logged rather than swallowed, because a firing that can never report looks
   * exactly like one whose workflow did nothing.
   */
  private async mintOutcomeAuthority(
    delivery: ClaimedSubscriptionDelivery,
    deviceId: DeviceId,
    issuedAt: number,
  ): Promise<{ token: string; expiresAt: number; tokenId: TokenId } | null> {
    const expiresAt = issuedAt + this.config.outcomeAuthorityTtlMs;
    let token: Awaited<ReturnType<WriteGate["createToken"]>> | undefined;
    try {
      token = await this.deps.writeGate.createToken(
        deviceId,
        [SCOPE_SUBSCRIPTIONS_OUTCOME],
        "subscription-firing-outcome",
        { ttlMs: this.config.outcomeAuthorityTtlMs },
      );
      const issued = await this.deps.writeGate.issueSubscriptionFiringOutcomeAuthority({
        id: `sfoa_${this.id()}`,
        deliveryId: delivery.id,
        tokenId: token.id,
        createdAt: issuedAt,
        expiresAt,
      });
      if (issued.outcome !== "issued") {
        await this.revokeBestEffort(token.id);
        this.deps.log.warn(
          `firing ${delivery.firingId}: outcome authority unavailable (${issued.outcome}) — this run cannot report`,
        );
        return null;
      }
      return { token: token.token, expiresAt, tokenId: token.id };
    } catch (error) {
      if (token) await this.revokeBestEffort(token.id);
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log.warn(`firing ${delivery.firingId}: outcome authority failed — ${message}`);
      return null;
    }
  }

  private async finishCommitRetry(
    delivery: ClaimedSubscriptionDelivery,
    rawMessage: string,
  ): Promise<DeliveryOutcome> {
    const settled = await this.deps.writeGate.settleSubscriptionDelivery({
      deliveryId: delivery.id,
      claimId: delivery.claimId,
      settledAt: this.now(),
      outcome: {
        kind: "retry_commit",
        error: rawMessage.slice(0, 2_000),
        nextAttemptAt: this.now() + subscriptionDeliveryBackoffMs(delivery.attempt, this.config),
      },
    });
    return settled.outcome === "settled" ? "retry" : "stale";
  }

  private async finishCommitPermanentFailure(
    delivery: ClaimedSubscriptionDelivery,
    rawMessage: string,
    code: string,
  ): Promise<DeliveryOutcome> {
    const settled = await this.deps.writeGate.settleSubscriptionDelivery({
      deliveryId: delivery.id,
      claimId: delivery.claimId,
      settledAt: this.now(),
      outcome: {
        kind: "failed_commit",
        code,
        error: rawMessage.slice(0, 2_000),
      },
    });
    return settled.outcome === "settled" ? "failed" : "stale";
  }

  private async finishCommitManualReview(
    delivery: ClaimedSubscriptionDelivery,
    rawMessage: string,
  ): Promise<DeliveryOutcome> {
    const settled = await this.deps.writeGate.settleSubscriptionDelivery({
      deliveryId: delivery.id,
      claimId: delivery.claimId,
      settledAt: this.now(),
      outcome: {
        kind: "manual_review",
        phase: "commit",
        code: "ambiguous_start",
        error: rawMessage.slice(0, 2_000),
      },
    });
    return settled.outcome === "settled" ? "failed" : "stale";
  }

  private async cancelPrepared(
    delivery: ClaimedSubscriptionDelivery,
    deviceId: DeviceId,
    protocolVersion: DeliveryProtocolVersion,
  ): Promise<DeliveryOutcome> {
    try {
      const response = await this.deps.transport.sendCommand(
        deviceId,
        "subscription.cancel",
        {
          protocolVersion,
          deliveryId: delivery.id,
        },
        this.config.commandTimeoutMs,
        SCOPE_SUBSCRIPTIONS_RECEIVE,
      );
      if (response.status === "too_late") {
        const settled = await this.deps.writeGate.settleSubscriptionDelivery({
          deliveryId: delivery.id,
          claimId: delivery.claimId,
          settledAt: this.now(),
          outcome: {
            kind: "manual_review",
            phase: "cancel",
            code: "cancel_too_late",
            error: "integration reported that cancellation arrived after native start",
          },
        });
        return settled.outcome === "settled" ? "failed" : "stale";
      }
      const settled = await this.deps.writeGate.settleSubscriptionDelivery({
        deliveryId: delivery.id,
        claimId: delivery.claimId,
        settledAt: this.now(),
        outcome: {
          kind: "cancelled",
          cancelledAt: response.cancelledAt,
        },
      });
      return settled.outcome === "settled" ? "failed" : "stale";
    } catch (error) {
      return this.finishCancelRetry(
        delivery,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async finishCancelRetry(
    delivery: ClaimedSubscriptionDelivery,
    rawMessage: string,
  ): Promise<DeliveryOutcome> {
    const settled = await this.deps.writeGate.settleSubscriptionDelivery({
      deliveryId: delivery.id,
      claimId: delivery.claimId,
      settledAt: this.now(),
      outcome: {
        kind: "retry_cancel",
        error: rawMessage.slice(0, 2_000),
        nextAttemptAt: this.now() + subscriptionDeliveryBackoffMs(delivery.attempt, this.config),
      },
    });
    return settled.outcome === "settled" ? "retry" : "stale";
  }

  private async finishFailure(
    delivery: ClaimedSubscriptionDelivery,
    rawMessage: string,
    prepareMayHaveReachedIntegration = false,
  ): Promise<DeliveryOutcome> {
    const message = rawMessage.slice(0, 2_000);
    const terminal = delivery.attempt >= this.config.maxAttempts;
    const settled = await this.deps.writeGate.settleSubscriptionDelivery({
      deliveryId: delivery.id,
      claimId: delivery.claimId,
      settledAt: this.now(),
      outcome: terminal
        ? prepareMayHaveReachedIntegration
          ? { kind: "queue_cancel", error: message, nextAttemptAt: this.now() }
          : { kind: "failed", error: message }
        : {
            kind: "retry",
            error: message,
            nextAttemptAt:
              this.now() + subscriptionDeliveryBackoffMs(delivery.attempt, this.config),
          },
    });
    if (settled.outcome !== "settled") return "stale";
    return terminal && !prepareMayHaveReachedIntegration ? "failed" : "retry";
  }

  private async parkOffline(delivery: ClaimedSubscriptionDelivery): Promise<DeliveryOutcome> {
    const settled = await this.deps.writeGate.settleSubscriptionDelivery({
      deliveryId: delivery.id,
      claimId: delivery.claimId,
      settledAt: this.now(),
      outcome: {
        kind: "parked",
        error: "agent integration is offline",
        nextAttemptAt: this.now() + subscriptionDeliveryBackoffMs(delivery.attempt, this.config),
      },
    });
    return settled.outcome === "settled" ? "retry" : "stale";
  }

  private async parkCapacity(delivery: ClaimedSubscriptionDelivery): Promise<DeliveryOutcome> {
    const settled = await this.deps.writeGate.settleSubscriptionDelivery({
      deliveryId: delivery.id,
      claimId: delivery.claimId,
      settledAt: this.now(),
      outcome: {
        kind: "parked",
        error: "agent integration is at its workflow concurrency limit",
        nextAttemptAt: this.now() + subscriptionDeliveryBackoffMs(delivery.attempt, this.config),
      },
    });
    return settled.outcome === "settled" ? "retry" : "stale";
  }

  private async revokeBestEffort(tokenId: Parameters<WriteGate["revokeToken"]>[0]): Promise<void> {
    try {
      await this.deps.writeGate.revokeToken(tokenId);
    } catch (err) {
      this.deps.log.warn(
        `failed to revoke abandoned subscription answer token: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
