// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/**
 * Frozen schema and cutover transform for migration 152.
 *
 * Later access-schema revisions must append migrations and extend the live
 * schema wrapper; changing this body would rewrite history for installations
 * upgrading from version 149.
 */
export function createV152AccessTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_principals (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('interactive', 'service')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS access_grants (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES access_principals(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_access_grants_principal ON access_grants(principal_id);

    CREATE TABLE IF NOT EXISTS access_grant_capabilities (
      grant_id TEXT NOT NULL REFERENCES access_grants(id) ON DELETE CASCADE,
      capability TEXT NOT NULL CHECK (capability IN ('direct', 'answer')),
      source_mode TEXT NOT NULL DEFAULT 'all'
        CHECK (source_mode IN ('all', 'allowlist', 'denylist')),
      source_ids TEXT NOT NULL DEFAULT '[]',
      privacy_policy TEXT,
      PRIMARY KEY (grant_id, capability),
      CHECK (json_valid(source_ids) AND json_type(source_ids) = 'array'),
      CHECK (source_mode = 'all' AND source_ids = '[]'),
      CHECK (
        (capability = 'direct' AND privacy_policy IS NULL) OR
        (capability = 'answer' AND privacy_policy = 'default')
      )
    );

    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      redirect_uris TEXT NOT NULL,
      grant_types TEXT NOT NULL,
      response_types TEXT NOT NULL,
      token_endpoint_auth_method TEXT NOT NULL CHECK (token_endpoint_auth_method = 'none'),
      client_uri TEXT,
      created_at INTEGER NOT NULL,
      CHECK (json_valid(redirect_uris) AND json_type(redirect_uris) = 'array'),
      CHECK (json_valid(grant_types) AND json_type(grant_types) = 'array'),
      CHECK (json_valid(response_types) AND json_type(response_types) = 'array')
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_clients_created
      ON oauth_clients(created_at, client_id);

    CREATE TABLE IF NOT EXISTS principal_credentials (
      id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL REFERENCES access_grants(id) ON DELETE CASCADE,
      oauth_client_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('interactive', 'service')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active')),
      label TEXT NOT NULL,
      client_secret_hash TEXT,
      execution_device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      expires_at INTEGER,
      revoked_at INTEGER,
      CHECK (
        (kind = 'interactive' AND client_secret_hash IS NULL) OR
        (kind = 'service' AND client_secret_hash IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_principal_credentials_grant
      ON principal_credentials(grant_id);
    CREATE INDEX IF NOT EXISTS idx_principal_credentials_oauth_client
      ON principal_credentials(oauth_client_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_principal_credentials_service_client
      ON principal_credentials(oauth_client_id) WHERE kind = 'service';

    CREATE TABLE IF NOT EXISTS oauth_execution_bindings (
      id TEXT PRIMARY KEY,
      binding_hash TEXT UNIQUE NOT NULL,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      oauth_client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      harness TEXT NOT NULL CHECK (harness IN ('openclaw', 'hermes')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_execution_bindings_expiry
      ON oauth_execution_bindings(expires_at, id);
    CREATE INDEX IF NOT EXISTS idx_oauth_execution_bindings_client
      ON oauth_execution_bindings(oauth_client_id);

    -- A connect client commits its one-use pairing code before it can persist
    -- the returned credentials. This short-lived, client-key-encrypted receipt
    -- lets the same connect attempt recover the identical response after a
    -- crash without storing replayable bearer material in plaintext.
    CREATE TABLE IF NOT EXISTS agent_pairing_redemption_receipts (
      idempotency_key_hash TEXT PRIMARY KEY,
      pairing_code_hash TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      sealed_response TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_pairing_redemption_receipts_expiry
      ON agent_pairing_redemption_receipts(expires_at, idempotency_key_hash);

    CREATE TABLE IF NOT EXISTS oauth_authorization_requests (
      id TEXT PRIMARY KEY,
      browser_handle_hash TEXT UNIQUE NOT NULL,
      user_code TEXT UNIQUE NOT NULL,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      client_name TEXT NOT NULL,
      client_uri TEXT,
      redirect_uri TEXT NOT NULL,
      state TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      resource TEXT NOT NULL,
      scope TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'denied', 'code-issued', 'complete')),
      selection_json TEXT,
      execution_device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
      decision_token_id TEXT,
      decision_at INTEGER,
      authorization_code_hash TEXT UNIQUE,
      authorization_code_expires_at INTEGER,
      authorization_code_issued_at INTEGER,
      authorization_code_consumed_at INTEGER,
      credential_id TEXT UNIQUE REFERENCES principal_credentials(id) ON DELETE SET NULL,
      created_grant_id TEXT UNIQUE REFERENCES access_grants(id) ON DELETE SET NULL,
      created_principal_id TEXT UNIQUE REFERENCES access_principals(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_authorization_requests_user_code
      ON oauth_authorization_requests(user_code);
    CREATE INDEX IF NOT EXISTS idx_oauth_authorization_requests_expiry
      ON oauth_authorization_requests(expires_at, id);
    CREATE INDEX IF NOT EXISTS idx_oauth_authorization_requests_code_expiry
      ON oauth_authorization_requests(status, authorization_code_expires_at, id);
    CREATE INDEX IF NOT EXISTS idx_oauth_authorization_requests_client
      ON oauth_authorization_requests(client_id);

    CREATE TABLE IF NOT EXISTS oauth_access_tokens (
      id TEXT PRIMARY KEY,
      credential_id TEXT NOT NULL REFERENCES principal_credentials(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      audience TEXT NOT NULL,
      scope TEXT NOT NULL,
      grant_revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_credential
      ON oauth_access_tokens(credential_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_expiry
      ON oauth_access_tokens(expires_at, id);

    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      id TEXT PRIMARY KEY,
      credential_id TEXT NOT NULL REFERENCES principal_credentials(id) ON DELETE CASCADE,
      family_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      token_hash TEXT UNIQUE NOT NULL,
      audience TEXT NOT NULL,
      scope TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      revoked_at INTEGER,
      UNIQUE (family_id, generation)
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_credential
      ON oauth_refresh_tokens(credential_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_expiry
      ON oauth_refresh_tokens(expires_at, id);

    CREATE TABLE IF NOT EXISTS access_audit_events (
      id TEXT PRIMARY KEY,
      occurred_at INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      principal_id TEXT,
      grant_id TEXT,
      grant_revision INTEGER,
      credential_id TEXT,
      oauth_client_id TEXT,
      actor_token_id TEXT,
      detail TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_access_audit_events_occurred
      ON access_audit_events(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_access_audit_events_principal
      ON access_audit_events(principal_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_access_audit_events_retention
      ON access_audit_events(occurred_at, id);
  `);
}

export function migrateV152AccessGrants(db: Db): void {
  createV152AccessTables(db);

  // Completion wakes are task-identity notifications in the OAuth design.
  // Remove the retired one-use device-token authority plane and any token it
  // left behind; integrations retrieve the task through their principal.
  db.exec("DROP TABLE IF EXISTS answer_completion_authorities");
  const completionTokens = db
    .prepare<
      [],
      { id: string; scopes: string }
    >("SELECT id, scopes FROM tokens WHERE scopes LIKE '%answer:completion%'")
    .all();
  const deleteToken = db.prepare("DELETE FROM tokens WHERE id = ?");
  for (const token of completionTokens) {
    const scopes = parseStringArray(token.scopes);
    if (scopes.length === 1 && scopes[0] === "answer:completion") deleteToken.run(token.id);
  }

  // Before principals existed, an integration's reusable device token carried
  // both subscriptions:manage and Answer. Preserve the operational pairing and
  // raw secret while removing corpus-read authority at the cutover boundary.
  const rows = db
    .prepare<[], { id: string; capabilities: string; scopes: string }>(
      `SELECT t.id, d.capabilities, t.scopes
       FROM tokens t JOIN devices d ON d.id = t.device_id
       WHERE d.kind = 'agent'`,
    )
    .all();
  const update = db.prepare("UPDATE tokens SET scopes = ? WHERE id = ?");
  for (const row of rows) {
    const capabilities = parseObject(row.capabilities);
    const scopes = parseStringArray(row.scopes);
    if (!capabilities || !("agentIntegration" in capabilities) || !scopes.includes("answer")) {
      continue;
    }
    update.run(JSON.stringify(scopes.filter((scope) => scope !== "answer")), row.id);
  }
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}
