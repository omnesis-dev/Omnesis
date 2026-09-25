// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  agentDeviceAuthorizations,
  agentDeviceRevocationImpacts,
  findConnectionProposal,
  getAuthorizationRequestByBrowserHandle,
  getAuthorizationRequestById,
  getAuthorizationRequestByUserCode,
  getRefreshTokenAudience,
  issueAuthorizationCodeById,
  getOAuthClient,
  listAccessAuditEvents,
  listAccessOverview,
  listPendingAuthorizationRequests,
  lookupPrincipalAccessToken,
  preflightAuthorizationRequest,
  preflightExecutionTokensReissue,
  preflightOAuthTokenExchange,
  preflightOAuthTokenRevocation,
  upsertOAuthMetadataClient,
} from "./store.js";
import { registeredRedirectMatches } from "./redirect-uri.js";
import { getLiveLevelRow } from "./store-level-summaries.js";
import { levelHasUsableAnswer } from "./store-level-writes.js";
import type { Db } from "../data/types.js";
import type { WriteGate } from "../write-gate.js";
import type {
  AccessAuditListInput,
  AccessConnectionLevelInput,
  AccessDeviceLevelInput,
  AccessLevelCreateInput,
  AccessLevelDeleteInput,
  AccessLevelUpdateInput,
  AccessPrincipalRenameInput,
  AccessRevocationInput,
  AccessGrantUpdateInput,
  AuthorizationRequestCreateInput,
  AuthorizationRequestDecisionInput,
  AuthorizationRequestPublic,
  ExecutionBindingCreateInput,
  OAuthClientRegistrationInput,
  OAuthClientMetadataDocument,
  OAuthTokenExchangeInput,
  McpToolInvocationAuditInput,
} from "./types.js";

/** Keeps durable-before-egress audit writes from flooding the shared writer queue. */
export const MAX_CONCURRENT_ACCESS_AUDIT_WRITES = 16;
export const MAX_PENDING_ACCESS_AUDIT_WRITES = 64;

export class AccessAuthorityChangedError extends Error {
  constructor() {
    super("MCP authority changed before the result could be released.");
    this.name = "AccessAuthorityChangedError";
  }
}

export class AccessService {
  private auditWritesInFlight = 0;
  private readonly auditWriteWaiters: Array<() => void> = [];

  constructor(
    private readonly reader: Db,
    private readonly writer: WriteGate,
  ) {}

  registerOAuthClient(input: OAuthClientRegistrationInput) {
    return this.writer.registerOAuthClient(input);
  }

  registerOAuthMetadataClient(input: OAuthClientMetadataDocument) {
    return this.writer.upsertOAuthMetadataClient(input);
  }

  isRegisteredRedirect(clientId: string, redirectUri: string): boolean {
    const client = getOAuthClient(this.reader, clientId);
    if (!client) return false;
    return client.redirectUris.some((registered) =>
      registeredRedirectMatches(registered, redirectUri),
    );
  }

  createExecutionBinding(input: ExecutionBindingCreateInput) {
    return this.writer.createExecutionBinding(input);
  }

  /** Re-key the OAuth credential already bound to one agent device. */
  reissueExecutionDeviceTokens(input: { deviceId: string; oauthClientId: string }) {
    if (!preflightExecutionTokensReissue(this.reader, input)) {
      return Promise.resolve({ ok: false, error: "not-found" } as const);
    }
    return this.writer.reissueExecutionDeviceTokens(input);
  }

  /** Which paired agent devices can still reach the corpus on their own. */
  agentDeviceAuthorizations(now?: number) {
    return agentDeviceAuthorizations(this.reader, now);
  }

  /** Whether a live level can release answers today — the bar for putting an integration on it. */
  levelCanAnswer(levelId: string): boolean {
    return (
      getLiveLevelRow(this.reader, levelId) !== null && levelHasUsableAnswer(this.reader, levelId)
    );
  }

  /** Live corpus authorities that revoking each agent device would end. */
  agentDeviceRevocationImpacts(now?: number) {
    return agentDeviceRevocationImpacts(this.reader, now);
  }

  createAuthorizationRequest(input: AuthorizationRequestCreateInput, resource: string) {
    if (input.resource !== resource) {
      return Promise.resolve({ ok: false, error: "invalid-resource" } as const);
    }
    const preflight = preflightAuthorizationRequest(this.reader, input);
    if (!preflight.ok) return Promise.resolve(preflight);
    return this.writer.createAuthorizationRequest(input);
  }

  enqueueAuthorizationNotification(
    requestId: string,
    deviceIds: readonly import("@omnesis/types").DeviceId[],
  ) {
    return this.writer.enqueueAccessAuthorizationNotification(requestId, deviceIds);
  }

  getAuthorizationByBrowserHandle(browserHandle: string) {
    return getAuthorizationRequestByBrowserHandle(this.reader, browserHandle);
  }

  getAuthorizationByUserCode(userCode: string) {
    return getAuthorizationRequestByUserCode(this.reader, userCode);
  }

  getAuthorizationById(requestId: string) {
    return getAuthorizationRequestById(this.reader, requestId);
  }

  /** What an approver is offered for a pending request; null once it is decided. */
  getConnectionProposal(request: AuthorizationRequestPublic) {
    if (request.status !== "pending") return null;
    return findConnectionProposal(this.reader, request.id);
  }

  decideAuthorizationRequest(input: AuthorizationRequestDecisionInput) {
    return this.writer.decideAuthorizationRequest(input);
  }

  issueAuthorizationCode(browserHandle: string) {
    return this.writer.issueAuthorizationCode(browserHandle);
  }

  issueAuthorizationCodeById(requestId: string) {
    return this.writer.issueAuthorizationCodeById(requestId);
  }

  exchangeOAuthToken(
    input: OAuthTokenExchangeInput,
    resource: string,
    supportedResources: readonly string[] = [resource],
  ) {
    if (input.resource !== undefined && input.resource !== resource) {
      return Promise.resolve({ ok: false, error: "invalid-resource" } as const);
    }
    let resolvedInput = input;
    if (input.grantType === "refresh_token" && input.resource === undefined) {
      const audience = getRefreshTokenAudience(this.reader, input.refreshToken);
      if (audience !== null && !supportedResources.includes(audience)) {
        return Promise.resolve({ ok: false, error: "invalid-resource" } as const);
      }
      if (audience !== null) resolvedInput = { ...input, resource: audience };
    }
    const preflight = preflightOAuthTokenExchange(this.reader, resolvedInput);
    if (!preflight.ok) return Promise.resolve(preflight);
    return this.writer.exchangeOAuthToken(resolvedInput);
  }

  updateGrant(input: AccessGrantUpdateInput) {
    return this.writer.updateAccessGrant(input);
  }

  createLevel(input: AccessLevelCreateInput) {
    return this.writer.createAccessLevel(input);
  }

  updateLevel(input: AccessLevelUpdateInput) {
    return this.writer.updateAccessLevel(input);
  }

  deleteLevel(input: AccessLevelDeleteInput) {
    return this.writer.deleteAccessLevel(input);
  }

  setConnectionLevel(input: AccessConnectionLevelInput) {
    return this.writer.setAccessConnectionLevel(input);
  }

  setDeviceLevel(input: AccessDeviceLevelInput) {
    return this.writer.setAccessDeviceLevel(input);
  }

  renamePrincipal(input: AccessPrincipalRenameInput) {
    return this.writer.renameAccessPrincipal(input);
  }

  revoke(input: AccessRevocationInput) {
    if (input.kind === "token") {
      const preflight = preflightOAuthTokenRevocation(this.reader, input);
      if (!preflight.ok) return Promise.resolve(preflight);
    }
    return this.writer.revokeAccessEntity(input);
  }

  async recordMcpToolInvocation(input: McpToolInvocationAuditInput): Promise<void> {
    await this.acquireAuditWriteSlot();
    try {
      const recorded = await this.writer.recordMcpToolInvocationAudit(input);
      if (!recorded) throw new AccessAuthorityChangedError();
    } finally {
      this.releaseAuditWriteSlot();
    }
  }

  overview() {
    return {
      ...listAccessOverview(this.reader),
      pendingRequests: listPendingAuthorizationRequests(this.reader),
    };
  }

  /** The access ledger, newest first. */
  listAuditEvents(input: AccessAuditListInput) {
    return listAccessAuditEvents(this.reader, input);
  }

  lookupAccessToken(rawToken: string, resource: string) {
    return lookupPrincipalAccessToken(this.reader, rawToken, resource);
  }

  private acquireAuditWriteSlot(): Promise<void> {
    if (this.auditWritesInFlight < MAX_CONCURRENT_ACCESS_AUDIT_WRITES) {
      this.auditWritesInFlight += 1;
      return Promise.resolve();
    }
    if (this.auditWriteWaiters.length >= MAX_PENDING_ACCESS_AUDIT_WRITES) {
      return Promise.reject(new Error("MCP access audit capacity exhausted."));
    }
    return new Promise((resolve) => {
      this.auditWriteWaiters.push(() => {
        this.auditWritesInFlight += 1;
        resolve();
      });
    });
  }

  private releaseAuditWriteSlot(): void {
    this.auditWritesInFlight -= 1;
    this.auditWriteWaiters.shift()?.();
  }
}
