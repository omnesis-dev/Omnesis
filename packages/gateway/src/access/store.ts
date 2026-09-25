// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Stable access-store façade.
 *
 * Schema ownership, OAuth client registration, the authorization-code flow
 * and the decisions it resolves, credentials/tokens, access levels, access
 * administration and the periodic cleanup sweep live in focused collaborators.
 * Callers continue to import the same public surface from this module.
 */

import { MCP_ACCESS_SCOPE } from "./types.js";

export type { AccessMutationError, AccessMutationResult } from "./store-contracts.js";
export { createAccessTables } from "./store-schema.js";
export {
  getOAuthClient,
  oauthClientAuthenticates,
  registerOAuthClient,
  upsertOAuthMetadataClient,
} from "./store-clients.js";
export { listAccessAuditEvents, recordMcpToolInvocationAudit } from "./store-audit.js";
export {
  preflightExecutionTokensReissue,
  preflightOAuthTokenExchange,
  preflightOAuthTokenRevocation,
} from "./store-preflight.js";
export { createExecutionBinding } from "./store-execution-bindings.js";
export {
  agentDeviceAuthorizations,
  agentDeviceRevocationImpacts,
} from "./agent-device-authorization.js";
export {
  createAuthorizationRequest,
  preflightAuthorizationRequest,
  decideAuthorizationRequest,
  exchangeAuthorizationCode,
  enqueueAccessAuthorizationNotification,
  getAuthorizationRequestByBrowserHandle,
  getAuthorizationRequestById,
  getAuthorizationRequestByUserCode,
  issueAuthorizationCode,
  issueAuthorizationCodeById,
  listPendingAuthorizationRequests,
} from "./store-authorization.js";
export {
  getRefreshTokenAudience,
  lookupPrincipalAccessToken,
  refreshPrincipalAccessToken,
  reissueExecutionDeviceTokens,
  touchPrincipalCredentialUsageBatch,
} from "./store-credentials.js";
export { cleanupExpiredAccessStateBatch } from "./store-cleanup.js";
export {
  listAccessOverview,
  removeConnection,
  removeProfile,
  renameAccessPrincipal,
  revokeAccessGrant,
  revokeAccessPrincipal,
  revokeOAuthToken,
  revokePrincipalCredential,
} from "./store-management.js";
export {
  createAccessLevel,
  deleteAccessLevel,
  setConnectionLevel,
  setDeviceLevel,
  updateAccessGrant,
  updateAccessLevel,
} from "./store-levels.js";
export { findConnectionProposal } from "./store-connections.js";
export type {
  AccessCleanupPhase,
  AccessCleanupResult,
  OAuthClientCleanupCursor,
} from "./store-cleanup.js";
export { exchangeOAuthToken, revokeAccessEntity } from "./store-mutations.js";

export function defaultAuthorizationScope(): string {
  return MCP_ACCESS_SCOPE;
}
