// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientInformationContext,
  type OAuthDiscoveryState,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";

export type TestGrantCapability = "direct" | "answer" | "notes";
export type TestGrantRule =
  | {
      capability: "direct" | "notes";
      sources: { mode: "all" | "allowlist" | "denylist"; sourceIds: string[] };
    }
  | {
      capability: "answer";
      sources: { mode: "all" | "allowlist" | "denylist"; sourceIds: string[] };
      release: { mode: "reviewed"; policyFamilyId: string } | { mode: "unreviewed" };
    };

export interface OAuthE2EGateway {
  gatewayUrl: string;
  apiKey: string;
  gatewayLogPath?: string;
}

export interface AuthorizedMcpClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
  provider: InMemoryOAuthClientProvider;
  portal: PortalSession;
  principalId: string;
  grantId: string;
  grantRevision: number;
  credentialId: string;
}

export interface PendingMcpAuthorization {
  provider: InMemoryOAuthClientProvider;
  client: Client;
  transport: StreamableHTTPClientTransport;
  consentUrl: URL;
  requestHandle: string;
}

export interface PortalSession {
  cookie: string;
  csrfToken: string;
}

export interface AccessOverview {
  sources?: Array<{ id: string; name: string; available: boolean }>;
  policyFamilies?: Array<{ id: string; name: string; revision: string }>;
  defaultPolicyFamilyId?: string;
  levels?: Array<{
    id: string;
    name: string;
    revision: number;
    rules: TestGrantRule[];
    connectionCount: number;
  }>;
  principals: Array<{
    id: string;
    name: string;
    revokedAt?: number | null;
    grants: Array<{
      id: string;
      name: string;
      revision: number;
      levelId?: string | null;
      revokedAt?: number | null;
      credentials: Array<{
        id: string;
        label: string;
        status: "pending" | "active";
        revokedAt?: number | null;
      }>;
    }>;
  }>;
}

/** The lookup envelope an approving client reads before it decides. */
export interface ConnectionLookup {
  request: { approvalId: string; clientName: string; requiresAnswer: boolean };
  reconnect: null;
  connection: {
    defaultName: string;
    defaultLevelName: string;
    match: {
      connectionId: string;
      connectionName: string;
      matchedBy: "device" | "client" | "name";
      levelId: string | null;
      grant: { id: string; revision: number; rules: TestGrantRule[] };
    } | null;
    recommended: "existing-level" | "new-level" | "replace";
  } | null;
}

export interface StagedConnectionApproval {
  portal: PortalSession;
  lookup: ConnectionLookup;
  /** Records the decision without completing the client's token exchange. */
  approve(selection: Record<string, unknown>): Promise<{
    /** Completes the exchange and connects an MCP client with the new sign-in. */
    finish(): Promise<AuthorizedMcpClient>;
  }>;
  close(): Promise<void>;
}

/**
 * Starts an agent sign-in and opens its approval the way a Portal or phone
 * approver does: short code, lookup, then a decision carrying any selection.
 * The connection the approval produced is found as the one active sign-in
 * that was not active just before the token exchange.
 *
 * Pass an existing provider to sign in again with the client it already
 * registered; pass an execution binding to stage a managed integration's
 * device-bound request.
 */
export async function stageConnectionApproval(
  gateway: OAuthE2EGateway,
  client: { clientName: string; redirectUrl: string } | InMemoryOAuthClientProvider,
  options: { executionBinding?: { deviceToken: string; harness: "openclaw" | "hermes" } } = {},
): Promise<StagedConnectionApproval> {
  const pending = await beginMcpAuthorization(
    gateway,
    options.executionBinding,
    client instanceof InMemoryOAuthClientProvider
      ? client
      : new InMemoryOAuthClientProvider(client),
  );
  const closePending = async (): Promise<void> => {
    await Promise.allSettled([pending.client.close(), pending.transport.close()]);
  };
  const closingPendingOnFailure = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      await closePending();
      throw error;
    }
  };
  return closingPendingOnFailure(async () => {
    const portal = await loginPortal(gateway);
    const consent = await fetch(pending.consentUrl);
    assertStatus(consent, 200, "load anonymous OAuth consent");
    const userCode = scrapeOAuthUserCode(await consent.text());
    const lookup = await portalJson<ConnectionLookup>(
      gateway.gatewayUrl,
      portal,
      "/portal/api/access/authorizations/lookup",
      { code: userCode },
    );
    return {
      portal,
      lookup,
      close: closePending,
      approve: (selection) =>
        closingPendingOnFailure(async () => {
          await decideOAuthAuthorization(gateway.gatewayUrl, portal, lookup.request.approvalId, {
            decision: "approve",
            selection,
          });
          return {
            finish: () =>
              closingPendingOnFailure(async () => {
                const activeBefore = activeCredentialIds(
                  await accessOverview(gateway.gatewayUrl, portal),
                );
                const completed = await completeOAuthAuthorization(
                  gateway.gatewayUrl,
                  pending.requestHandle,
                );
                assertStatus(completed, 303, "complete authorization");
                const callback = new URL(requiredHeader(completed, "location"));
                await pending.transport.finishAuth(callback.searchParams);
                await closePending();
                return connectNewSignIn(gateway, portal, pending.provider, activeBefore);
              }),
          };
        }),
    };
  });
}

async function connectNewSignIn(
  gateway: OAuthE2EGateway,
  portal: PortalSession,
  provider: InMemoryOAuthClientProvider,
  activeBefore: Set<string>,
): Promise<AuthorizedMcpClient> {
  const overview = await accessOverview(gateway.gatewayUrl, portal);
  const matches = overview.principals.flatMap((principal) =>
    principal.grants.flatMap((grant) =>
      grant.credentials
        .filter(
          (credential) =>
            credential.status === "active" &&
            !credential.revokedAt &&
            !activeBefore.has(credential.id),
        )
        .map((credential) => ({ principal, grant, credential })),
    ),
  );
  const [match] = matches;
  if (!match || matches.length !== 1) {
    throw new Error(
      `Expected exactly one new active sign-in after the exchange, found ${matches.length}.${gatewayLogTail(gateway.gatewayLogPath)}`,
    );
  }
  const transport = transportFor(gateway.gatewayUrl, provider);
  const connected = clientFor("omnesis-connection-e2e");
  try {
    await connected.connect(transport);
  } catch (error) {
    await Promise.allSettled([connected.close(), transport.close()]);
    throw new Error(
      `The approved sign-in could not connect to MCP.${gatewayLogTail(gateway.gatewayLogPath)}`,
      { cause: error },
    );
  }
  return {
    client: connected,
    transport,
    provider,
    portal,
    principalId: match.principal.id,
    grantId: match.grant.id,
    grantRevision: match.grant.revision,
    credentialId: match.credential.id,
  };
}

function activeCredentialIds(overview: AccessOverview): Set<string> {
  return new Set(
    overview.principals.flatMap((principal) =>
      principal.grants.flatMap((grant) =>
        grant.credentials
          .filter((credential) => credential.status === "active" && !credential.revokedAt)
          .map((credential) => credential.id),
      ),
    ),
  );
}

export interface OAuthConsentRequest {
  approvalId: string;
  userCode: string;
}

export class InMemoryOAuthClientProvider implements OAuthClientProvider {
  readonly redirectUrl: URL;
  readonly stateValue = `state-${randomUUID()}`;
  readonly clientMetadata: OAuthClientMetadata;
  authorizationUrl: URL | null = null;
  authorizationRedirects = 0;
  savedClientInformation: StoredOAuthClientInformation | undefined;
  savedTokens: StoredOAuthTokens | undefined;
  private verifier: string | undefined;
  private savedDiscovery: OAuthDiscoveryState | undefined;

  constructor(
    options: {
      redirectUrl?: string;
      clientName?: string;
      clientUri?: string;
      duplicateResourceIndicator?: boolean;
    } = {},
  ) {
    this.redirectUrl = new URL(options.redirectUrl ?? "http://127.0.0.1:48123/callback");
    this.clientMetadata = {
      client_name: options.clientName ?? "Omnesis MCP E2E client",
      client_uri: options.clientUri ?? "https://example.com/omnesis-mcp-e2e",
      redirect_uris: [this.redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    this.duplicateResourceIndicator = options.duplicateResourceIndicator ?? false;
  }

  private readonly duplicateResourceIndicator: boolean;

  state(): string {
    return this.stateValue;
  }

  clientInformation(
    _context?: OAuthClientInformationContext,
  ): StoredOAuthClientInformation | undefined {
    return this.savedClientInformation;
  }

  saveClientInformation(clientInformation: StoredOAuthClientInformation): void {
    this.savedClientInformation = clientInformation;
  }

  tokens(_context?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    return this.savedTokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.savedTokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationRedirects += 1;
    this.authorizationUrl = new URL(authorizationUrl);
    if (this.duplicateResourceIndicator) {
      const resource = this.authorizationUrl.searchParams.get("resource");
      if (resource) this.authorizationUrl.searchParams.append("resource", resource);
    }
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("The SDK did not persist a PKCE verifier.");
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.savedDiscovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.savedDiscovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") this.savedClientInformation = undefined;
    if (scope === "all" || scope === "tokens") this.savedTokens = undefined;
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    if (scope === "all" || scope === "discovery") this.savedDiscovery = undefined;
  }
}

export async function authorizeMcpClient(
  gateway: OAuthE2EGateway,
  input: {
    principalName: string;
    grantName: string;
    credentialLabel: string;
    capabilities: TestGrantCapability[];
    /** Exact V2 rules. Omit to retain the all-sources V1 test shorthand. */
    rules?: TestGrantRule[];
    approval?: "short-code" | "authenticated-popup";
    existingGrantId?: string;
    executionBinding?: { deviceToken: string; harness: "openclaw" | "hermes" };
    client?: {
      redirectUrl: string;
      clientName: string;
      clientUri?: string;
      duplicateResourceIndicator?: boolean;
    };
  },
): Promise<AuthorizedMcpClient> {
  const pending = await beginMcpAuthorization(
    gateway,
    input.executionBinding,
    new InMemoryOAuthClientProvider(input.client),
  );
  const {
    provider,
    client: firstClient,
    transport: firstTransport,
    consentUrl,
    requestHandle,
  } = pending;
  try {
    const portal = await loginPortal(gateway);
    const overview = await accessOverview(gateway.gatewayUrl, portal);
    const approval = input.approval ?? "short-code";
    const consent = await fetch(consentUrl, {
      headers: approval === "authenticated-popup" ? { Cookie: portal.cookie } : {},
      redirect: "manual",
    });
    const expectedConsentStatus = approval === "authenticated-popup" ? 303 : 200;
    if (consent.status !== expectedConsentStatus) {
      throw new Error(
        `load consent returned HTTP ${consent.status}; expected ${expectedConsentStatus}${gatewayLogTail(gateway.gatewayLogPath)}`,
      );
    }
    let approvalId: string;
    if (approval === "authenticated-popup") {
      const portalTarget = new URL(requiredHeader(consent, "location"), gateway.gatewayUrl);
      const match = portalTarget.pathname.match(
        /^\/portal\/settings\/access\/authorizations\/([^/]+)$/,
      );
      if (!match?.[1] || portalTarget.searchParams.get("completion") !== "portal") {
        throw new Error("The authenticated OAuth popup did not target its Portal approval page.");
      }
      approvalId = decodeURIComponent(match[1]);
    } else {
      const consentHtml = await consent.text();
      const userCode = scrapeOAuthUserCode(consentHtml);
      const lookup = await lookupOAuthConsentCode(gateway.gatewayUrl, portal, userCode);
      approvalId = lookup.approvalId;
    }
    await decideOAuthAuthorization(gateway.gatewayUrl, portal, approvalId, {
      decision: "approve",
      selection: input.existingGrantId
        ? {
            kind: "existing-grant",
            grantId: input.existingGrantId,
            credentialLabel: input.credentialLabel,
          }
        : {
            kind: "new-principal",
            principalName: input.principalName,
            grantName: input.grantName,
            rules:
              input.rules ??
              rulesForCapabilities(input.capabilities, overview.defaultPolicyFamilyId),
            credentialLabel: input.credentialLabel,
            expiresAt: null,
          },
    });

    let callback: URL;
    if (approval === "authenticated-popup") {
      const completed = await portalJson<{ redirectTo: string }>(
        gateway.gatewayUrl,
        portal,
        `/portal/api/access/authorizations/${encodeURIComponent(approvalId)}/complete`,
        {},
      );
      callback = new URL(completed.redirectTo);
    } else {
      const completed = await completeOAuthAuthorization(gateway.gatewayUrl, requestHandle);
      assertStatus(completed, 303, "complete authorization");
      callback = new URL(requiredHeader(completed, "location"));
    }
    if (callback.searchParams.get("state") !== provider.stateValue) {
      throw new Error("The OAuth callback state did not match the SDK-generated request state.");
    }
    await firstTransport.finishAuth(callback.searchParams);
    if (!provider.savedTokens?.access_token || !provider.savedTokens.refresh_token) {
      throw new Error("The MCP SDK did not persist the exchanged OAuth token pair.");
    }
    await Promise.allSettled([firstClient.close(), firstTransport.close()]);

    const approvedOverview = await accessOverview(gateway.gatewayUrl, portal);
    const principal = approvedOverview.principals.find(
      (candidate) => candidate.name === input.principalName,
    );
    const grant = principal?.grants.find((candidate) => candidate.name === input.grantName);
    const credential = grant?.credentials.find(
      (candidate) => candidate.label === input.credentialLabel,
    );
    if (!principal || !grant || !credential) {
      throw new Error("The approved principal, grant, and credential were not visible in Portal.");
    }
    const transport = transportFor(gateway.gatewayUrl, provider);
    const client = clientFor("omnesis-oauth-authorized");
    try {
      await client.connect(transport);
    } catch (error) {
      await Promise.allSettled([client.close(), transport.close()]);
      throw new Error(
        `The approved OAuth credential could not connect to MCP. Grant: ${JSON.stringify(grant)}${gatewayLogTail(gateway.gatewayLogPath)}`,
        { cause: error },
      );
    }
    return {
      client,
      transport,
      provider,
      portal,
      principalId: principal.id,
      grantId: grant.id,
      grantRevision: grant.revision,
      credentialId: credential.id,
    };
  } catch (error) {
    await Promise.allSettled([firstClient.close(), firstTransport.close()]);
    throw error;
  }
}

export async function beginMcpAuthorization(
  gateway: OAuthE2EGateway,
  executionBinding?: { deviceToken: string; harness: "openclaw" | "hermes" },
  provider = new InMemoryOAuthClientProvider(),
): Promise<PendingMcpAuthorization> {
  const firstTransport = transportFor(gateway.gatewayUrl, provider);
  const firstClient = clientFor("omnesis-oauth-bootstrap");
  let initialError: unknown;
  try {
    await firstClient.connect(firstTransport);
  } catch (error) {
    initialError = error;
  }
  if (!initialError || !provider.authorizationUrl) {
    await Promise.allSettled([firstClient.close(), firstTransport.close()]);
    throw new Error("The MCP SDK did not begin interactive OAuth after the resource challenge.");
  }
  if (!provider.savedClientInformation?.client_id) {
    await Promise.allSettled([firstClient.close(), firstTransport.close()]);
    throw new Error("The MCP SDK did not persist Dynamic Client Registration metadata.");
  }

  try {
    if (executionBinding) {
      const response = await fetch(`${gateway.gatewayUrl}/agent-integration/oauth-binding`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${executionBinding.deviceToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientId: provider.savedClientInformation.client_id,
          harness: executionBinding.harness,
        }),
      });
      assertStatus(response, 201, "create execution binding");
      const result = (await response.json()) as { binding?: string };
      if (!result.binding) throw new Error("The execution-binding response omitted its secret.");
      provider.authorizationUrl.searchParams.set("omnesis_execution_binding", result.binding);
    }

    const started = await fetch(provider.authorizationUrl, { redirect: "manual" });
    assertStatus(started, 303, "start authorization");
    const consentUrl = new URL(requiredHeader(started, "location"), gateway.gatewayUrl);
    const requestHandle = consentUrl.searchParams.get("request");
    if (!requestHandle) throw new Error("The authorization response omitted its consent handle.");
    return {
      provider,
      client: firstClient,
      transport: firstTransport,
      consentUrl,
      requestHandle,
    };
  } catch (error) {
    await Promise.allSettled([firstClient.close(), firstTransport.close()]);
    throw error;
  }
}

export async function revokeAccess(
  gatewayUrl: string,
  portal: PortalSession,
  target: { kind: "credential" | "grant" | "connection" | "profile"; id: string },
): Promise<void> {
  const result = await portalJson<{ revoked: boolean }>(
    gatewayUrl,
    portal,
    "/portal/api/access/revoke",
    target,
  );
  if (!result.revoked) throw new Error(`Portal did not revoke the ${target.kind}.`);
}

export async function updateAccessGrant(
  gatewayUrl: string,
  portal: PortalSession,
  grantId: string,
  expectedRevision: number,
  rules: TestGrantRule[],
): Promise<number> {
  const result = await portalJson<{ grant: { revision: number } }>(
    gatewayUrl,
    portal,
    `/admin/access/grants/${encodeURIComponent(grantId)}`,
    { expectedRevision, rules },
    "PATCH",
  );
  return result.grant.revision;
}

export function clientFor(name: string): Client {
  return new Client(
    { name, version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } }, defaultCacheTtlMs: 0 },
  );
}

export function transportFor(
  gatewayUrl: string,
  provider: OAuthClientProvider,
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp`), {
    authProvider: provider,
    onInsufficientScope: "throw",
  });
}

export async function loginPortal(gateway: OAuthE2EGateway): Promise<PortalSession> {
  const response = await fetch(`${gateway.gatewayUrl}/portal/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: gateway.apiKey }),
  });
  assertStatus(response, 200, "log in to Portal");
  const body = (await response.json()) as { csrfToken?: string };
  const setCookie = requiredHeader(response, "set-cookie");
  const cookie = setCookie.split(";", 1)[0];
  if (!cookie || !body.csrfToken) throw new Error("Portal login omitted its session material.");
  return { cookie, csrfToken: body.csrfToken };
}

export async function portalJson<T>(
  gatewayUrl: string,
  portal: PortalSession,
  path: string,
  body?: unknown,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await portalFetch(gatewayUrl, portal, method, path, body);
  if (!response.ok) assertStatus(response, 200, path);
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} returned a non-JSON success response: ${text.slice(0, 80)}`);
  }
}

/** A Portal call whose non-2xx status and error body the caller asserts on. */
export async function portalRequest(
  gatewayUrl: string,
  portal: PortalSession,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await portalFetch(gatewayUrl, portal, method, path, body);
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

function portalFetch(
  gatewayUrl: string,
  portal: PortalSession,
  method: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${gatewayUrl}${path}`, {
    method,
    headers: {
      Cookie: portal.cookie,
      ...(method === "GET" ? {} : { "X-Omnesis-CSRF": portal.csrfToken }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function accessOverview(
  gatewayUrl: string,
  portal: PortalSession,
): Promise<AccessOverview> {
  return portalJson(gatewayUrl, portal, "/admin/access");
}

export function scrapeOAuthUserCode(consentHtml: string): string {
  const userCode = consentHtml.match(/data-user-code>([A-Z2-9]{4}-[A-Z2-9]{4})</u)?.[1];
  if (!userCode) throw new Error("The anonymous consent page omitted its short code.");
  return userCode;
}

export async function lookupOAuthConsent(
  gatewayUrl: string,
  portal: PortalSession,
  consentUrl: URL,
): Promise<OAuthConsentRequest> {
  const response = await fetch(consentUrl);
  assertStatus(response, 200, "load anonymous OAuth consent");
  return lookupOAuthConsentCode(gatewayUrl, portal, scrapeOAuthUserCode(await response.text()));
}

export async function lookupOAuthConsentCode(
  gatewayUrl: string,
  portal: PortalSession,
  userCode: string,
): Promise<OAuthConsentRequest> {
  const lookup = await portalJson<{ request: { approvalId: string } }>(
    gatewayUrl,
    portal,
    "/portal/api/access/authorizations/lookup",
    { code: userCode },
  );
  return { approvalId: lookup.request.approvalId, userCode };
}

export async function decideOAuthAuthorization(
  gatewayUrl: string,
  portal: PortalSession,
  approvalId: string,
  decision: Record<string, unknown>,
): Promise<void> {
  await portalJson(
    gatewayUrl,
    portal,
    `/portal/api/access/authorizations/${encodeURIComponent(approvalId)}/decision`,
    decision,
  );
}

export function newAnswerPrincipalSelection(
  overview: AccessOverview,
  principalName: string,
  labels: { grantName?: string; credentialLabel?: string } = {},
): Record<string, unknown> {
  if (!overview.defaultPolicyFamilyId) {
    throw new Error("Access overview omitted its default policy family.");
  }
  return {
    kind: "new-principal",
    principalName,
    grantName: labels.grantName ?? `${principalName} grant`,
    credentialLabel: labels.credentialLabel ?? `${principalName} credential`,
    rules: [
      {
        capability: "answer",
        sources: { mode: "all", sourceIds: [] },
        release: { mode: "reviewed", policyFamilyId: overview.defaultPolicyFamilyId },
      },
    ],
    expiresAt: null,
  };
}

export async function completeOAuthAuthorization(
  gatewayUrl: string,
  request: string | URL | PendingMcpAuthorization,
): Promise<Response> {
  const requestHandle =
    typeof request === "string"
      ? request
      : request instanceof URL
        ? request.searchParams.get("request")
        : request.requestHandle;
  if (!requestHandle) throw new Error("OAuth consent URL omitted its request handle.");
  return fetch(
    `${gatewayUrl}/oauth/authorize/complete?request=${encodeURIComponent(requestHandle)}`,
    { redirect: "manual" },
  );
}

function rulesForCapabilities(
  capabilities: TestGrantCapability[],
  defaultPolicyFamilyId: string | undefined,
): TestGrantRule[] {
  return capabilities.map((capability): TestGrantRule => {
    if (capability === "direct" || capability === "notes") {
      return { capability, sources: { mode: "all", sourceIds: [] } };
    }
    if (!defaultPolicyFamilyId) {
      throw new Error("The access overview omitted its default privacy-policy family.");
    }
    return {
      capability: "answer",
      sources: { mode: "all", sourceIds: [] },
      release: { mode: "reviewed", policyFamilyId: defaultPolicyFamilyId },
    };
  });
}

export function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (!value) throw new Error(`OAuth response omitted ${name}.`);
  return value;
}

function assertStatus(response: Response, expected: number, operation: string): void {
  if (response.status !== expected) {
    throw new Error(`${operation} returned HTTP ${response.status}; expected ${expected}.`);
  }
}

function gatewayLogTail(path: string | undefined): string {
  if (!path) return "";
  try {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n").slice(-30);
    return lines.length ? `\n--- gateway log ---\n${lines.join("\n")}` : "";
  } catch {
    return "";
  }
}
