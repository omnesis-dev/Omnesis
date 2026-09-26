// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const MCP_ACCESS_SCOPE = "omnesis:access";

export type AccessCapability = "direct" | "answer" | "notes";
export type AccessSourceMode = "all" | "allowlist" | "denylist";
export type AnswerReleaseMode = "reviewed" | "unreviewed";
export type McpInvocationAuditOutcome = "ok" | "refused" | "cancelled" | "timed_out" | "failed";
export type PrincipalKind = "interactive";
export type PrincipalCredentialKind = "interactive";
export type PrincipalCredentialStatus = "pending" | "active";

export interface AccessGrantCapability {
  capability: AccessCapability;
  sourceMode: AccessSourceMode;
  sourceIds: string[];
  releaseMode: AnswerReleaseMode | null;
  policyFamilyId: string | null;
  policyRevision: string | null;
  /** Legacy display alias; new writes use the tagged release fields above. */
  privacyPolicy: string | null;
}

export type AccessGrantRuleInput =
  | {
      capability: "direct" | "notes";
      sources: { mode: AccessSourceMode; sourceIds: string[] };
    }
  | {
      capability: "answer";
      sources: { mode: AccessSourceMode; sourceIds: string[] };
      release: { mode: "reviewed"; policyFamilyId: string } | { mode: "unreviewed" };
    };

export interface AccessPrincipal {
  id: string;
  name: string;
  kind: PrincipalKind;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

export interface AccessGrant {
  id: string;
  principalId: string;
  name: string;
  revision: number;
  /** The access level this grant's permissions come from. Null only for revoked or legacy rows. */
  levelId: string | null;
  capabilities: AccessGrantCapability[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

export interface PrincipalCredential {
  id: string;
  grantId: string;
  oauthClientId: string;
  kind: PrincipalCredentialKind;
  status: PrincipalCredentialStatus;
  label: string;
  /** The self-reported name of the OAuth client that signs in, when it is still registered. */
  clientName: string | null;
  executionDeviceId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
}

/** One row of the access ledger, as the admin audit route lists it. */
export interface AccessAuditEvent {
  id: string;
  occurredAt: number;
  eventType: string;
  principalId: string | null;
  grantId: string | null;
  grantRevision: number | null;
  credentialId: string | null;
  oauthClientId: string | null;
  actorTokenId: string | null;
  detail: Record<string, unknown>;
}

export interface AccessAuditListInput {
  limit: number;
  /** The last row of the previous page; the next page starts strictly after it. */
  after?: { occurredAt: number; id: string };
  principalId?: string;
  grantId?: string;
}

/** Non-corpus metadata recorded for one authenticated MCP tool invocation. */
export interface McpToolInvocationAuditInput {
  accessTokenId: string;
  principalId: string;
  grantId: string;
  grantRevision: number;
  credentialId: string;
  oauthClientId: string;
  capability: AccessCapability;
  tool: string;
  outcome: McpInvocationAuditOutcome;
  requestId: string;
  sourceMode: AccessSourceMode;
  /** Successful corpus results must still be authorized at their egress boundary. */
  requireActiveAuthority: boolean;
}

export interface OAuthClientRegistration {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: OAuthClientAuthMethod;
  /** Returned exactly once by dynamic registration for confidential clients. */
  clientSecret: string | null;
  /** Where a `private_key_jwt` client publishes its signing keys; null for every other method. */
  jwksUri: string | null;
  /**
   * The one algorithm a `private_key_jwt` client's metadata document says it
   * signs with; null when the document names none, and for every other method.
   */
  tokenEndpointAuthSigningAlg: ClientAssertionAlgorithm | null;
  clientUri: string | null;
  createdAt: number;
}

/** Asymmetric JWS algorithms a `private_key_jwt` client may sign its assertion with. */
export type ClientAssertionAlgorithm = "RS256" | "PS256" | "ES256";

/**
 * How a client authenticates at the token and revocation endpoints. Dynamic
 * registration offers `none` and `client_secret_basic`; `private_key_jwt` is
 * reachable only through a Client ID Metadata Document that names a JWKS.
 */
export type OAuthClientAuthMethod = "none" | "client_secret_basic" | "private_key_jwt";

export type OAuthClientRegistrationInput = Omit<
  OAuthClientRegistration,
  | "clientId"
  | "createdAt"
  | "clientSecret"
  | "tokenEndpointAuthMethod"
  | "jwksUri"
  | "tokenEndpointAuthSigningAlg"
> & {
  /** Public clients remain the default for existing internal callers. */
  tokenEndpointAuthMethod?: "none" | "client_secret_basic";
};

export type OAuthClientMetadataDocument = Omit<
  OAuthClientRegistrationInput,
  "tokenEndpointAuthMethod"
> & { clientId: string } & (
    | { tokenEndpointAuthMethod: "none"; jwksUri: null; tokenEndpointAuthSigningAlg: null }
    | {
        tokenEndpointAuthMethod: "private_key_jwt";
        jwksUri: string;
        tokenEndpointAuthSigningAlg: ClientAssertionAlgorithm | null;
      }
  );

/**
 * A `private_key_jwt` client assertion the HTTP layer has already verified
 * against the keys published at `jwksUri`. Signature verification needs the
 * network, so it happens before the request reaches the writer; the writer
 * then only confirms this proof names the client, key set and signing
 * algorithm it has on record.
 */
export interface VerifiedClientAssertion {
  method: "private_key_jwt";
  clientId: string;
  jwksUri: string;
  /** The algorithm the assertion was signed with. */
  alg: ClientAssertionAlgorithm;
}

/** What a request presented to authenticate its client. At most one field is set. */
export interface OAuthClientCredentials {
  clientSecret?: string;
  clientAssertion?: VerifiedClientAssertion;
}

export type AuthorizationGrantSelection =
  | {
      kind: "new-principal";
      principalName: string;
      grantName: string;
      rules: AccessGrantRuleInput[];
      credentialLabel: string;
      expiresAt: number | null;
    }
  | {
      kind: "new-grant";
      principalId: string;
      grantName: string;
      rules: AccessGrantRuleInput[];
      credentialLabel: string;
      expiresAt: number | null;
    }
  | {
      kind: "existing-grant";
      grantId: string;
      credentialLabel: string;
    };

/**
 * The primitive a decided request remembers. A replacement is recorded on
 * its `existing-grant`: activating that credential revokes the grant's other
 * active sign-ins. No caller can ask for `replaces` directly.
 */
export type StoredAuthorizationGrantSelection =
  | Exclude<AuthorizationGrantSelection, { kind: "existing-grant" }>
  | (Extract<AuthorizationGrantSelection, { kind: "existing-grant" }> & { replaces?: true });

/**
 * What an older client sends to be connected: what it may do, and nothing
 * about where that lands. The gateway gives it a new connection named after
 * the client, on a new access level named after the client, carrying these
 * rules. It never joins an existing connection.
 */
export interface AuthorizationConnectSelection {
  kind: "connect";
  rules: AccessGrantRuleInput[];
  /** Defaults to the connection's name. */
  credentialLabel?: string;
}

/** A new connection, on a new access level with these rules or on an existing level. */
export interface AuthorizationNewConnectionSelection {
  kind: "new-connection";
  name: string;
  level:
    | { kind: "new"; name: string; rules: AccessGrantRuleInput[] }
    | { kind: "existing"; levelId: string; expectedLevelRevision: number };
}

/** A new sign-in for an existing connection, which retires its other sign-ins once used. */
export interface AuthorizationReplaceConnectionSelection {
  kind: "replace-connection";
  connectionId: string;
  expectedGrantRevision: number;
}

export type AuthorizationDecisionSelection =
  | AuthorizationGrantSelection
  | AuthorizationConnectSelection
  | AuthorizationNewConnectionSelection
  | AuthorizationReplaceConnectionSelection;

export type AuthorizationRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "code-issued"
  | "complete"
  | "expired";

export interface AuthorizationRequestPublic {
  id: string;
  status: AuthorizationRequestStatus;
  clientId: string;
  clientName: string;
  clientUri: string | null;
  redirectOrigin: string;
  userCode: string;
  resource: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
  decisionAt: number | null;
  /** Integration-bound requests must retain privacy-reviewed Answer access. */
  requiresAnswer: boolean;
}

export interface AuthorizationRequestPortal extends AuthorizationRequestPublic {
  approvalId: string;
  selection: StoredAuthorizationGrantSelection | null;
}

export interface AccessAuthorizationNotificationEnqueueResult {
  requestId: string;
  expiresAt: number;
  deviceIds: import("@omnesis/types").DeviceId[];
}

export interface PrincipalAccessTokenInfo {
  accessTokenId: string;
  principalId: string;
  principalName: string;
  grantId: string;
  grantRevision: number;
  credentialId: string;
  oauthClientId: string;
  executionDeviceId: string | null;
  capabilities: AccessGrantCapability[];
  audience: string;
  scopes: string[];
  expiresAt: number;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType: "Bearer";
  expiresIn: number;
  scope: string;
}

export interface AuthorizationRequestCreateInput {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  /** One-use binding minted under an active OpenClaw/Hermes device credential. */
  executionBinding?: string;
  ttlMs?: number;
}

export interface ExecutionBindingCreateInput {
  deviceId: string;
  oauthClientId: string;
  harness: "openclaw" | "hermes";
}

export interface ExecutionBindingCreateResult {
  binding: string;
  expiresAt: number;
}

export type AuthorizationRequestDecisionInput = {
  approvalId: string;
  decision: "approve" | "deny";
  selection?: AuthorizationDecisionSelection;
  actorTokenId: string;
};

export type OAuthTokenExchangeInput =
  | {
      grantType: "authorization_code";
      code: string;
      clientId: string;
      redirectUri: string;
      codeVerifier: string;
      clientSecret?: string;
      clientAssertion?: VerifiedClientAssertion;
      resource: string;
    }
  | {
      grantType: "refresh_token";
      refreshToken: string;
      clientId: string;
      clientSecret?: string;
      clientAssertion?: VerifiedClientAssertion;
      /** Optional on refresh; omission reuses the credential's bound audience. */
      resource?: string;
    };

export interface AccessGrantUpdateInput {
  grantId: string;
  expectedRevision: number;
  rules: AccessGrantRuleInput[];
  actorTokenId: string;
}

/** A new name for a live principal; the audit row names who asked. */
export interface AccessPrincipalRenameInput {
  principalId: string;
  name: string;
  actorTokenId: string;
}

export interface AccessGrantUpdateResult {
  grantId: string;
  revision: number;
  capabilities: AccessGrantCapability[];
}

export interface AccessLevelCreateInput {
  name: string;
  rules: AccessGrantRuleInput[];
  actorTokenId: string;
}

export interface AccessLevelUpdateInput {
  levelId: string;
  expectedRevision: number;
  name?: string;
  rules?: AccessGrantRuleInput[];
  actorTokenId: string;
}

export interface AccessLevelDeleteInput {
  levelId: string;
  actorTokenId: string;
}

/**
 * Move a connection onto an existing level, taking that level's rules, or
 * onto a new level that copies the connection's current rules. An expected
 * level revision refuses the move when the level changed since it was shown.
 */
export type AccessConnectionLevelInput = {
  connectionId: string;
  expectedGrantRevision: number;
  actorTokenId: string;
} & ({ levelId: string; expectedLevelRevision?: number } | { newLevel: { name: string } });

export interface AccessConnectionLevelResult {
  grant: AccessGrantUpdateResult;
  level: AccessLevelSummary;
}

/**
 * Put a paired device on an access level, or with `levelId: null` take it
 * off. A device on a level has the level's Answer rule applied to what it
 * asks over `/answer`; a device on none answers from every source under the
 * default privacy policy. An expected level revision refuses the change when
 * the level changed since it was shown.
 */
export interface AccessDeviceLevelInput {
  deviceId: string;
  levelId: string | null;
  expectedLevelRevision?: number;
  actorTokenId: string;
}

export interface AccessDeviceLevelResult {
  deviceId: string;
  /** The level the device is now on; null when it is on none. */
  level: AccessLevelSummary | null;
}

export type AccessRevocationInput =
  | { kind: "credential"; id: string; actorTokenId: string }
  /**
   * A connection as the owner sees it: the credential, and with it the grant
   * and the agent when this was the last live thing under each. What is left
   * behind is what the owner would have had to find and revoke by hand.
   */
  | { kind: "connection"; id: string; actorTokenId: string }
  /**
   * An access profile as the owner sees it: the grant, and with it the agent
   * when this was the last live profile it held.
   */
  | { kind: "profile"; id: string; actorTokenId: string }
  | { kind: "grant"; id: string; actorTokenId: string }
  | { kind: "principal"; id: string; actorTokenId: string }
  | {
      kind: "token";
      token: string;
      clientId: string;
      clientSecret?: string;
      clientAssertion?: VerifiedClientAssertion;
    };

/** A request awaiting the operator's decision, as the overview lists it. */
export interface PendingAuthorizationRequest {
  id: string;
  clientName: string;
  userCode: string;
  createdAt: number;
  expiresAt: number;
}

export interface AccessOverview {
  /** Undecided, unexpired requests, newest first, for the client's waiting banner. */
  pendingRequests: PendingAuthorizationRequest[];
  sources: Array<{
    id: string;
    name: string;
    icon: string | null;
    available: boolean;
  }>;
  policyFamilies: Array<{
    id: string;
    name: string;
    revision: string;
    deletionBlockedReason?: string | null;
  }>;
  defaultPolicyFamilyId?: string;
  /** Transitional alias for clients built against the first V2 draft. */
  privacyPolicies?: Array<{ id: string; name: string; revision: string }>;
  /** Live access levels, sorted by name without regard to case. */
  levels: AccessLevelSummary[];
  principals: Array<
    AccessPrincipal & {
      grants: Array<
        AccessGrant & {
          /** Canonical wire representation; capabilities remains a compatibility alias. */
          rules: AccessGrantRuleInput[];
          credentials: PrincipalCredential[];
        }
      >;
    }
  >;
}

/** One grant as the overview lists it: its rules on the wire, and its credentials. */
export type AccessGrantSummary = AccessOverview["principals"][number]["grants"][number];

/** A named, reusable set of rules that every member connection carries. */
export interface AccessLevelSummary {
  id: string;
  name: string;
  revision: number;
  rules: AccessGrantRuleInput[];
  /** Live connections on this level. */
  connectionCount: number;
  /** Paired, unrevoked devices whose `/answer` requests use this level. */
  devices: Array<{ id: string; name: string; kind: string }>;
  createdAt: number;
  updatedAt: number;
}

/**
 * What an approver is offered for a pending request: names for a new
 * connection and a new level, and the most relevant live connection from the
 * same app. The match only informs the choice; nothing is joined unless the
 * approver picks an existing level or a replacement explicitly.
 */
export interface AccessConnectionProposal {
  defaultName: string;
  defaultLevelName: string;
  match: null | {
    connectionId: string;
    connectionName: string;
    /**
     * `device`: a live sign-in bound to the request's execution device.
     * `client`: the newest live sign-in of the same registered OAuth client.
     * `name`: the newest live sign-in of a client registered under the same name.
     */
    matchedBy: "device" | "client" | "name";
    levelId: string | null;
    grant: AccessGrantSummary;
  };
  recommended: "existing-level" | "new-level" | "replace";
}
