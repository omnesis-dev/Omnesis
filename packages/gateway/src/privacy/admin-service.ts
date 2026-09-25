// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";

import { createLogger } from "@omnesis/core";
import { TokenId } from "@omnesis/types";
import { deviceIdForToken } from "../data/repositories/TokenRepository.js";
import {
  directAuditSessionExists,
  getDirectAuditEvent,
  getPrivacyApproval,
  getPrivacyAuditEvent,
  getPrivacyConversation,
  getPrivacyReviewerHealth,
  listDirectAuditEvents,
  listDirectAuditSessions,
  listPrivacyApprovalPage,
  listPrivacyApprovals,
  listPrivacyAuditEvents,
  listPrivacyConversations,
  listPrivacyDecisions,
  listPrivacyExchangeFeed,
  listPrivacyExchangePresentations,
} from "./store.js";
import {
  listPrivacyPolicyFamilies,
  listPrivacyPolicyVersions,
  privacyPolicyFamilyVersion,
  privacyPolicyVersion,
} from "./policy-history.js";
import {
  PRIVACY_POLICY_TEMPLATES,
  PrivacyPolicyConflictError,
  PrivacyPolicyValidationError,
} from "./policy-store.js";
import { applyPrivacyPolicySchemaEdit } from "./policy-schema.js";
import type {
  ApprovalResolutionRequestContext,
  DirectAuditEvent,
  DirectAuditEventDetail,
  DirectAuditSession,
  PrivacyApprovalPage,
} from "./store.js";
import type Database from "better-sqlite3";
import type {
  AnswerResponse,
  PrivacyApprovalDetail,
  PrivacyApprovalStatus,
  PrivacyApprovalSummary,
  PrivacyDecisionSummary,
  PrivacyAuditEventDetail,
  PrivacyAuditEventPage,
  PrivacyConversationDetail,
  PrivacyConversationPage,
  PrivacyExchangeFeedPage,
  PrivacyExchangePresentationPage,
  PrivacyPolicyDocument,
  PrivacyPolicyFamilySummary,
  PrivacyPolicySchemaEdit,
  PrivacyPolicyTemplate,
  PrivacyPolicyVersion,
  PrivacyPolicyVersionSummary,
  PrivacyReviewerHealth,
} from "@omnesis/types/privacy";

import type { PrivacyPolicyStore } from "./policy-store.js";
import type { WriteGate } from "../write-gate.js";

const log = createLogger("gateway:privacy:admin");

/**
 * What a policy write did, as the four things that can happen to one: it landed,
 * the stored text is not something the controls can rewrite, the revision moved
 * under the client, or the result is text the store will not hold. Returned
 * rather than thrown so the route maps outcomes to status codes without having
 * to know which errors the store raises.
 */
export type PrivacyPolicyWriteResult =
  | { outcome: "written"; document: PrivacyPolicyDocument }
  | { outcome: "unparseable" }
  | { outcome: "conflict"; message: string; current: PrivacyPolicyDocument }
  | { outcome: "invalid"; message: string };

export interface PrivacyAdminServiceDeps {
  db: Database.Database;
  policyStore: Pick<
    PrivacyPolicyStore,
    "get" | "update" | "revert" | "getFamily" | "createFamily" | "updateFamily" | "restoreFamily"
  >;
  writeGate: Pick<
    WriteGate,
    "resolvePrivacyApproval" | "deletePrivacyConversation" | "deleteDirectAuditSession"
  >;
  now?: () => number;
  releaseIdGen?: () => string;
}

/**
 * Domain facade for the trusted operator's privacy administration surface.
 *
 * Read methods never touch the writer: lapsed pending approvals are presented
 * as expired at read time (`effectiveApprovalStatus`), and the periodic sweep
 * installed by the agent lifecycle materializes the flip and its audit trail.
 * Routing a read through the writer queue would park it behind whatever bulk
 * write is in flight (see #199).
 */
export class PrivacyAdminService {
  private readonly now: () => number;
  private readonly releaseIdGen: () => string;

  constructor(private readonly deps: PrivacyAdminServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.releaseIdGen = deps.releaseIdGen ?? (() => `release_${randomUUID()}`);
  }

  getPolicy(): Promise<PrivacyPolicyDocument> {
    return this.deps.policyStore.get();
  }

  listPolicyFamilies(): PrivacyPolicyFamilySummary[] {
    return listPrivacyPolicyFamilies(this.deps.db);
  }

  getPolicyFamily(familyId: string): Promise<PrivacyPolicyDocument | null> {
    return this.deps.policyStore.getFamily(familyId);
  }

  async createPolicyFamily(input: {
    name: string;
    templateId?: string;
    forkRevision?: string;
  }): Promise<PrivacyPolicyWriteResult> {
    if (Number(input.templateId !== undefined) + Number(input.forkRevision !== undefined) !== 1) {
      return {
        outcome: "invalid",
        message: "Exactly one privacy policy template or fork revision is required.",
      };
    }
    const template = input.templateId
      ? PRIVACY_POLICY_TEMPLATES.find((candidate) => candidate.id === input.templateId)
      : undefined;
    const origin = input.forkRevision ? this.versionByRevision(input.forkRevision) : undefined;
    if (input.templateId && !template) {
      return { outcome: "invalid", message: "Privacy policy template not found." };
    }
    if (input.forkRevision && !origin) {
      return { outcome: "invalid", message: "Privacy policy version not found." };
    }
    try {
      const document = await this.deps.policyStore.createFamily({
        name: input.name,
        policy: template?.policy ?? origin!.policy,
        action: template ? "template" : "fork",
        ...(template ? { originTemplateId: template.id } : { originRevision: origin!.revision }),
      });
      return { outcome: "written", document };
    } catch (err) {
      return this.policyError(err);
    }
  }

  async putPolicyFamily(
    familyId: string,
    policy: string,
    guard: { expectedRevision?: string; beforeVersion?: number },
  ): Promise<PrivacyPolicyWriteResult> {
    try {
      const current = await this.deps.policyStore.getFamily(familyId);
      if (!current) return { outcome: "invalid", message: "Privacy policy family not found." };
      if (guard.beforeVersion !== undefined && current.familyVersion !== guard.beforeVersion) {
        return {
          outcome: "conflict",
          message: "The privacy policy changed since it was loaded.",
          current,
        };
      }
      const expectedRevision = guard.expectedRevision ?? current.revision;
      const document = await this.deps.policyStore.updateFamily(
        familyId,
        expectedRevision,
        () => policy,
      );
      return document
        ? { outcome: "written", document }
        : { outcome: "invalid", message: "Privacy policy family not found." };
    } catch (err) {
      return this.policyError(err);
    }
  }

  listPolicyFamilyHistory(
    familyId: string,
    options: { limit: number; beforeVersion?: number },
  ): PrivacyPolicyVersionSummary[] {
    return listPrivacyPolicyVersions(this.deps.db, { ...options, familyId });
  }

  getPolicyFamilyVersion(familyId: string, generation: number): PrivacyPolicyVersion | null {
    return privacyPolicyFamilyVersion(this.deps.db, familyId, generation);
  }

  async restorePolicyFamily(
    familyId: string,
    generation: number,
    expectedRevision: string,
  ): Promise<PrivacyPolicyWriteResult> {
    const version = this.getPolicyFamilyVersion(familyId, generation);
    if (!version) return { outcome: "invalid", message: "Privacy policy version not found." };
    try {
      const document = await this.deps.policyStore.restoreFamily(
        familyId,
        expectedRevision,
        version,
      );
      return { outcome: "written", document };
    } catch (err) {
      return this.policyError(err);
    }
  }

  private versionByRevision(revision: string): PrivacyPolicyVersion | null {
    const row = this.deps.db
      .prepare<
        [string],
        { generation: number }
      >("SELECT generation FROM privacy_policy_versions WHERE revision = ?")
      .get(revision);
    return row ? privacyPolicyVersion(this.deps.db, row.generation) : null;
  }

  private policyError(err: unknown): PrivacyPolicyWriteResult {
    if (err instanceof PrivacyPolicyConflictError) {
      return { outcome: "conflict", message: err.message, current: err.current };
    }
    if (err instanceof PrivacyPolicyValidationError) {
      return { outcome: "invalid", message: err.message };
    }
    if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
      return { outcome: "invalid", message: "A privacy policy with this name already exists." };
    }
    throw err;
  }

  /** Replace the whole policy with text the operator wrote themselves. */
  putPolicy(policy: string, expectedRevision: string): Promise<PrivacyPolicyWriteResult> {
    return this.writePolicy("policy text", expectedRevision, () => policy);
  }

  /**
   * Apply one decision change to the stored policy without the client having to
   * author markdown. The splice runs against the text `expectedRevision` names,
   * inside the store's own turn, so a stale client cannot overwrite prose it
   * never saw.
   */
  editPolicySchema(
    edit: PrivacyPolicySchemaEdit,
    expectedRevision: string,
  ): Promise<PrivacyPolicyWriteResult> {
    return this.writePolicy("decision table", expectedRevision, (policy) =>
      applyPrivacyPolicySchemaEdit(policy, edit),
    );
  }

  /**
   * Every refusal is logged, because each one is a control the operator used
   * and a change they will not find in the policy afterwards.
   */
  private async writePolicy(
    subject: string,
    expectedRevision: string,
    edit: (policy: string) => string | null,
  ): Promise<PrivacyPolicyWriteResult> {
    try {
      const document = await this.deps.policyStore.update(expectedRevision, edit);
      if (document) return { outcome: "written", document };
      log.warn(`Refused ${subject} edit: the stored policy cannot express it`);
      return { outcome: "unparseable" };
    } catch (err) {
      if (err instanceof PrivacyPolicyConflictError) {
        log.warn(
          `Refused ${subject} edit: revision ${expectedRevision} is no longer the stored one`,
        );
        return { outcome: "conflict", message: err.message, current: err.current };
      }
      if (err instanceof PrivacyPolicyValidationError) {
        log.warn(`Refused ${subject} edit: ${err.message}`);
        return { outcome: "invalid", message: err.message };
      }
      throw err;
    }
  }

  listPolicyTemplates(): readonly PrivacyPolicyTemplate[] {
    return PRIVACY_POLICY_TEMPLATES;
  }

  listPolicyHistory(options: {
    limit: number;
    beforeGeneration?: number;
  }): PrivacyPolicyVersionSummary[] {
    return listPrivacyPolicyVersions(this.deps.db, options);
  }

  getPolicyVersion(generation: number): PrivacyPolicyVersion | null {
    return privacyPolicyVersion(this.deps.db, generation);
  }

  async revertPolicy(
    generation: number,
    expectedRevision: string,
  ): Promise<PrivacyPolicyWriteResult> {
    const version = privacyPolicyVersion(this.deps.db, generation);
    if (!version) return { outcome: "invalid", message: "Privacy policy version not found." };
    try {
      const document = await this.deps.policyStore.revert(
        expectedRevision,
        version.policy,
        generation,
      );
      return { outcome: "written", document };
    } catch (err) {
      if (err instanceof PrivacyPolicyConflictError) {
        return { outcome: "conflict", message: err.message, current: err.current };
      }
      if (err instanceof PrivacyPolicyValidationError) {
        return { outcome: "invalid", message: err.message };
      }
      throw err;
    }
  }

  listApprovals(status: PrivacyApprovalStatus | "all", limit: number): PrivacyApprovalSummary[] {
    return listPrivacyApprovals(this.deps.db, status, limit, this.now());
  }

  listApprovalPage(
    status: PrivacyApprovalStatus | "all",
    limit: number,
    cursor?: string,
  ): PrivacyApprovalPage {
    return listPrivacyApprovalPage(this.deps.db, status, limit, cursor, this.now());
  }

  getApproval(approvalId: string): PrivacyApprovalDetail | null {
    return getPrivacyApproval(this.deps.db, approvalId, this.now());
  }

  resolveApproval(
    approvalId: string,
    action: "approve" | "deny",
    requestContext: ApprovalResolutionRequestContext,
  ): Promise<AnswerResponse | null> {
    const tokenId = requestContext.tokenId ? TokenId(requestContext.tokenId) : null;
    return this.deps.writeGate.resolvePrivacyApproval({
      approvalId,
      action,
      requestContext: {
        ...requestContext,
        deviceId:
          requestContext.deviceId ?? (tokenId ? deviceIdForToken(this.deps.db, tokenId) : null),
      },
      releaseId: this.releaseIdGen(),
      now: this.now(),
    });
  }

  listDecisions(limit: number): PrivacyDecisionSummary[] {
    return listPrivacyDecisions(this.deps.db, limit, this.now());
  }

  listConversations(limit: number, cursor?: string): PrivacyConversationPage {
    return listPrivacyConversations(this.deps.db, limit, cursor, this.now());
  }

  getConversation(conversationId: string): PrivacyConversationDetail | null {
    return getPrivacyConversation(this.deps.db, conversationId, this.now());
  }

  listAuditEvents(
    conversationId: string,
    limit: number,
    cursor?: string,
  ): PrivacyAuditEventPage | null {
    return listPrivacyAuditEvents(this.deps.db, conversationId, limit, cursor);
  }

  listExchanges(
    conversationId: string,
    limit: number,
    cursor?: string,
    includeAgentTracesTaskId?: string,
  ): PrivacyExchangePresentationPage | null {
    return listPrivacyExchangePresentations(
      this.deps.db,
      conversationId,
      limit,
      cursor,
      this.now(),
      includeAgentTracesTaskId,
    );
  }

  listExchangeFeed(limit: number, cursor?: string): PrivacyExchangeFeedPage {
    return listPrivacyExchangeFeed(this.deps.db, { limit, cursor }, this.now());
  }

  getReviewerHealth(): PrivacyReviewerHealth {
    return getPrivacyReviewerHealth(this.deps.db, this.now());
  }

  getAuditEvent(conversationId: string, eventId: string): PrivacyAuditEventDetail | null {
    return getPrivacyAuditEvent(this.deps.db, conversationId, eventId);
  }

  deleteConversation(conversationId: string): Promise<boolean> {
    return this.deps.writeGate.deletePrivacyConversation({
      conversationId,
      now: this.now(),
    });
  }

  listDirectSessions(limit: number): DirectAuditSession[] {
    return listDirectAuditSessions(this.deps.db, null, limit);
  }

  listDirectSessionEvents(sessionId: string, limit: number): DirectAuditEvent[] | null {
    if (!directAuditSessionExists(this.deps.db, null, sessionId)) return null;
    return listDirectAuditEvents(this.deps.db, null, sessionId, limit);
  }

  getDirectEvent(eventId: string): DirectAuditEventDetail | null {
    return getDirectAuditEvent(this.deps.db, null, eventId);
  }

  deleteDirectSession(sessionId: string): Promise<boolean> {
    return this.deps.writeGate.deleteDirectAuditSession(sessionId);
  }
}
