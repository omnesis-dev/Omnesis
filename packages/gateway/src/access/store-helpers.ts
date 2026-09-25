// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as z from "zod/v4";

import {
  grantRulesSchema,
  legacyGrantRules,
  normalizeGrantRules,
  validateGrantRuleReferences,
} from "./store-rules.js";
import type { Db } from "../data/types.js";
import type {
  AuthorizationDecisionSelection,
  AuthorizationGrantSelection,
  AuthorizationRequestPortal,
  AuthorizationRequestPublic,
  AuthorizationRequestStatus,
  OAuthTokenSet,
  StoredAuthorizationGrantSelection,
} from "./types.js";

export const ACCESS_TOKEN_TTL_MS = 10 * 60_000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
export const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60_000;
export const AUTHORIZATION_CODE_TTL_MS = 2 * 60_000;
const USER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const capabilitiesSchema = z
  .array(z.enum(["direct", "answer", "notes"]))
  .min(1)
  .max(3)
  .refine((values) => new Set(values).size === values.length);

const newPrincipalSelectionSchema = z.strictObject({
  kind: z.literal("new-principal"),
  principalName: z.string().min(1).max(120),
  grantName: z.string().min(1).max(120),
  rules: grantRulesSchema,
  credentialLabel: z.string().min(1).max(160),
  expiresAt: z.number().int().positive().nullable(),
});
const newGrantSelectionSchema = z.strictObject({
  kind: z.literal("new-grant"),
  principalId: z.string().uuid(),
  grantName: z.string().min(1).max(120),
  rules: grantRulesSchema,
  credentialLabel: z.string().min(1).max(160),
  expiresAt: z.number().int().positive().nullable(),
});
const existingGrantSelectionFields = {
  kind: z.literal("existing-grant"),
  grantId: z.string().uuid(),
  credentialLabel: z.string().min(1).max(160),
};
const canonicalSelectionSchema = z.discriminatedUnion("kind", [
  newPrincipalSelectionSchema,
  newGrantSelectionSchema,
  z.strictObject(existingGrantSelectionFields),
]);
const connectionNameSchema = z.string().trim().min(1).max(120);
const decisionOnlySelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("connect"),
    rules: grantRulesSchema,
    credentialLabel: z.string().min(1).max(160).optional(),
  }),
  z.strictObject({
    kind: z.literal("new-connection"),
    name: connectionNameSchema,
    level: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("new"),
        name: connectionNameSchema,
        rules: grantRulesSchema,
      }),
      z.strictObject({
        kind: z.literal("existing"),
        levelId: z.string().uuid(),
        expectedLevelRevision: z.number().int().positive(),
      }),
    ]),
  }),
  z.strictObject({
    kind: z.literal("replace-connection"),
    connectionId: z.string().uuid(),
    expectedGrantRevision: z.number().int().positive(),
  }),
]);
/** What a request row remembers: a decision primitive, which may record a replacement. */
const storedSelectionSchema = z.discriminatedUnion("kind", [
  newPrincipalSelectionSchema,
  newGrantSelectionSchema,
  z.strictObject({ ...existingGrantSelectionFields, replaces: z.literal(true).optional() }),
]);
const legacySelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("new-principal"),
    principalName: z.string().min(1).max(120),
    grantName: z.string().min(1).max(120),
    capabilities: capabilitiesSchema,
    credentialLabel: z.string().min(1).max(160),
    expiresAt: z.number().int().positive().nullable(),
  }),
  z.strictObject({
    kind: z.literal("new-grant"),
    principalId: z.string().uuid(),
    grantName: z.string().min(1).max(120),
    capabilities: capabilitiesSchema,
    credentialLabel: z.string().min(1).max(160),
    expiresAt: z.number().int().positive().nullable(),
  }),
  z.strictObject(existingGrantSelectionFields),
]);

export interface AuthorizationRequestRow {
  id: string;
  browser_handle_hash: string;
  user_code: string;
  client_id: string;
  client_name: string;
  client_uri: string | null;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  resource: string;
  scope: string;
  created_at: number;
  expires_at: number;
  status: string;
  selection_json: string | null;
  execution_device_id: string | null;
  decision_token_id: string | null;
  decision_at: number | null;
  authorization_code_hash: string | null;
  authorization_code_expires_at: number | null;
  authorization_code_issued_at: number | null;
  authorization_code_consumed_at: number | null;
  credential_id: string | null;
  created_grant_id: string | null;
  created_principal_id: string | null;
  created_level_id: string | null;
}

export interface ActiveCredentialRow {
  credential_id: string;
  credential_status: "pending" | "active";
  grant_id: string;
  oauth_client_id: string;
  execution_device_id: string | null;
  credential_expires_at: number | null;
  credential_revoked_at: number | null;
  grant_revision: number;
  grant_expires_at: number | null;
  grant_revoked_at: number | null;
  principal_id: string;
  principal_name: string;
  principal_revoked_at: number | null;
}

export function parseAuthorizationSelection(
  selection: unknown,
): AuthorizationGrantSelection | null {
  const parsed = canonicalSelectionSchema.safeParse(selection);
  return parsed.success ? parsed.data : null;
}

/**
 * A decision's selection: a primitive, or one of the connection choices the
 * gateway resolves itself inside the decision.
 */
export function parseDecisionSelection(selection: unknown): AuthorizationDecisionSelection | null {
  const resolved = decisionOnlySelectionSchema.safeParse(selection);
  if (resolved.success) return resolved.data;
  return parseAuthorizationSelection(selection);
}

function parseStoredAuthorizationSelection(
  selection: unknown,
): StoredAuthorizationGrantSelection | null {
  const current = storedSelectionSchema.safeParse(selection);
  if (current.success) return current.data;
  const legacy = legacySelectionSchema.safeParse(selection);
  if (!legacy.success) return null;
  if (legacy.data.kind === "existing-grant") return legacy.data;
  const { capabilities, ...common } = legacy.data;
  return { ...common, rules: legacyGrantRules(capabilities) };
}

export function findAuthorizationRowByBrowserHandle(
  db: Db,
  browserHandle: string,
): AuthorizationRequestRow | null {
  return (
    db
      .prepare<
        [string],
        AuthorizationRequestRow
      >("SELECT * FROM oauth_authorization_requests WHERE browser_handle_hash = ?")
      .get(hashSecret(browserHandle)) ?? null
  );
}

export function findAuthorizationRowById(
  db: Db,
  approvalId: string,
): AuthorizationRequestRow | null {
  return (
    db
      .prepare<
        [string],
        AuthorizationRequestRow
      >("SELECT * FROM oauth_authorization_requests WHERE id = ?")
      .get(approvalId) ?? null
  );
}

export function publicAuthorization(
  row: AuthorizationRequestRow,
  now: number,
): AuthorizationRequestPublic {
  return {
    id: row.id,
    status: effectiveStatus(row, now),
    clientId: row.client_id,
    clientName: row.client_name,
    clientUri: row.client_uri,
    redirectOrigin: new URL(row.redirect_uri).origin,
    userCode: formatUserCode(row.user_code),
    resource: row.resource,
    scope: row.scope,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decisionAt: row.decision_at,
    requiresAnswer: row.execution_device_id !== null,
  };
}

export function portalAuthorization(
  row: AuthorizationRequestRow,
  now: number,
): AuthorizationRequestPortal {
  return {
    ...publicAuthorization(row, now),
    approvalId: row.id,
    selection: parseSelection(row.selection_json),
  };
}

function effectiveStatus(row: AuthorizationRequestRow, now: number): AuthorizationRequestStatus {
  if (row.expires_at <= now && row.status !== "complete") return "expired";
  return row.status as Exclude<AuthorizationRequestStatus, "expired">;
}

export function parseSelection(json: string | null): StoredAuthorizationGrantSelection | null {
  if (!json) return null;
  try {
    return parseStoredAuthorizationSelection(JSON.parse(json));
  } catch {
    return null;
  }
}

export function selectionIsUsable(
  db: Db,
  selection: StoredAuthorizationGrantSelection,
  now: number,
): boolean {
  if (selection.kind !== "existing-grant") {
    try {
      validateGrantRuleReferences(db, normalizeGrantRules(selection.rules));
    } catch {
      return false;
    }
  }
  if (selection.kind === "new-principal") {
    return selection.expiresAt === null || selection.expiresAt > now;
  }
  if (selection.kind === "new-grant") {
    if (selection.expiresAt !== null && selection.expiresAt <= now) return false;
    const principal = db
      .prepare<
        [string],
        { kind: string; revoked_at: number | null }
      >("SELECT kind, revoked_at FROM access_principals WHERE id = ?")
      .get(selection.principalId);
    return !!principal && principal.kind === "interactive" && principal.revoked_at === null;
  }
  return getActiveGrant(db, selection.grantId, now)?.principal_kind === "interactive";
}

export function getActiveGrant(
  db: Db,
  grantId: string,
  now: number,
): {
  id: string;
  principal_id: string;
  /** Read raw: the schema still admits the legacy `service` kind, which never qualifies. */
  principal_kind: string;
  revision: number;
  expires_at: number | null;
  level_id: string | null;
} | null {
  const row = db
    .prepare<
      [string],
      {
        id: string;
        principal_id: string;
        revision: number;
        expires_at: number | null;
        level_id: string | null;
        revoked_at: number | null;
        principal_revoked_at: number | null;
        principal_kind: string;
      }
    >(
      `SELECT g.*, p.kind AS principal_kind, p.revoked_at AS principal_revoked_at
       FROM access_grants g JOIN access_principals p ON p.id = g.principal_id
       WHERE g.id = ?`,
    )
    .get(grantId);
  if (
    !row ||
    row.revoked_at !== null ||
    row.principal_revoked_at !== null ||
    (row.expires_at !== null && row.expires_at <= now)
  ) {
    return null;
  }
  return row;
}

export function getActiveCredential(
  db: Db,
  credentialId: string,
  now: number,
): ActiveCredentialRow | null {
  const row = db
    .prepare<[string], ActiveCredentialRow>(
      `SELECT
         c.id AS credential_id, c.grant_id, c.oauth_client_id, c.execution_device_id,
         c.status AS credential_status,
         c.expires_at AS credential_expires_at, c.revoked_at AS credential_revoked_at,
         g.revision AS grant_revision, g.expires_at AS grant_expires_at,
         g.revoked_at AS grant_revoked_at, p.id AS principal_id,
         p.name AS principal_name, p.revoked_at AS principal_revoked_at
       FROM principal_credentials c
       JOIN access_grants g ON g.id = c.grant_id
       JOIN access_principals p ON p.id = g.principal_id
       WHERE c.id = ?`,
    )
    .get(credentialId);
  if (
    !row ||
    row.credential_status !== "active" ||
    row.credential_revoked_at !== null ||
    row.grant_revoked_at !== null ||
    row.principal_revoked_at !== null ||
    (row.credential_expires_at !== null && row.credential_expires_at <= now) ||
    (row.grant_expires_at !== null && row.grant_expires_at <= now) ||
    (row.execution_device_id !== null &&
      db
        .prepare<
          [string],
          { present: number }
        >("SELECT 1 AS present FROM devices WHERE id = ? AND revoked_at IS NULL")
        .get(row.execution_device_id) === undefined)
  ) {
    return null;
  }
  return row;
}

export function issueTokenPair(
  db: Db,
  input: {
    credentialId: string;
    grantRevision: number;
    audience: string;
    scope: string;
    familyId?: string;
    generation?: number;
    authorityExpiresAt: number | null;
    includeRefreshToken?: boolean;
    now: number;
  },
): OAuthTokenSet {
  const access = issueAccessToken(db, input);
  if (input.includeRefreshToken === false) return access;
  const refreshToken = `omn_ort_${randomBytes(32).toString("base64url")}`;
  const refreshExpiresAt = earlierExpiry(
    input.now + REFRESH_TOKEN_TTL_MS,
    input.authorityExpiresAt,
  );
  db.prepare(
    `INSERT INTO oauth_refresh_tokens (
       id, credential_id, family_id, generation, token_hash, audience, scope,
       created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.credentialId,
    input.familyId ?? randomUUID(),
    input.generation ?? 0,
    hashSecret(refreshToken),
    input.audience,
    input.scope,
    input.now,
    refreshExpiresAt,
  );
  return { ...access, refreshToken };
}

function issueAccessToken(
  db: Db,
  input: {
    credentialId: string;
    grantRevision: number;
    audience: string;
    scope: string;
    authorityExpiresAt: number | null;
    now: number;
  },
): OAuthTokenSet {
  const accessToken = `omn_oat_${randomBytes(32).toString("base64url")}`;
  const expiresAt = earlierExpiry(input.now + ACCESS_TOKEN_TTL_MS, input.authorityExpiresAt);
  db.prepare(
    `INSERT INTO oauth_access_tokens (
       id, credential_id, token_hash, audience, scope, grant_revision,
       created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.credentialId,
    hashSecret(accessToken),
    input.audience,
    input.scope,
    input.grantRevision,
    input.now,
    expiresAt,
  );
  return {
    accessToken,
    tokenType: "Bearer",
    expiresIn: Math.max(0, Math.floor((expiresAt - input.now) / 1000)),
    scope: input.scope,
  };
}

function earlierExpiry(first: number, second: number | null): number {
  return second === null ? first : Math.min(first, second);
}

export function appendAudit(
  db: Db,
  input: {
    eventType: string;
    principalId?: string;
    grantId?: string;
    grantRevision?: number;
    credentialId?: string;
    oauthClientId?: string;
    actorTokenId?: string | null;
    detail?: Record<string, unknown>;
    now: number;
  },
): void {
  db.prepare(
    `INSERT INTO access_audit_events (
       id, occurred_at, event_type, principal_id, grant_id, grant_revision,
       credential_id, oauth_client_id, actor_token_id, detail
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.now,
    input.eventType,
    input.principalId ?? null,
    input.grantId ?? null,
    input.grantRevision ?? null,
    input.credentialId ?? null,
    input.oauthClientId ?? null,
    input.actorTokenId ?? null,
    JSON.stringify(input.detail ?? {}),
  );
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function secretHashMatches(expectedHash: string, secret: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(hashSecret(secret), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function pkceMatches(expectedChallenge: string, verifier: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const actual = createHash("sha256").update(verifier).digest("base64url");
  const expected = Buffer.from(expectedChallenge, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  return expected.length === actualBytes.length && timingSafeEqual(expected, actualBytes);
}

/**
 * A random base64url secret whose last character is alphanumeric.
 *
 * These secrets travel inside URLs that people paste into chat and mail
 * clients, whose link detection stops at a trailing `-` or `_`; a secret
 * ending that way arrives truncated and looks up nothing. Re-rolling until
 * the final character is a letter or digit costs nothing in entropy (the
 * secret is discarded whole, never trimmed) and keeps every pasted link
 * intact.
 */
export function urlSafeSecret(bytes: number): string {
  for (;;) {
    const candidate = randomBytes(bytes).toString("base64url");
    if (/[A-Za-z0-9]$/.test(candidate)) return candidate;
  }
}

export function generateUserCode(): string {
  const bytes = randomBytes(8);
  let value = "";
  for (const byte of bytes) value += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  return value;
}

export function normalizeUserCode(value: string): string | null {
  const normalized = value.toUpperCase().replace(/[\s-]/g, "");
  return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(normalized) ? normalized : null;
}

export function formatUserCode(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

export function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}
