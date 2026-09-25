// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

import { activeAccessTokenPredicate } from "./active-access-token.js";
import { appendAudit } from "./store-helpers.js";
import type { Db } from "../data/types.js";
import type {
  AccessAuditEvent,
  AccessAuditListInput,
  McpToolInvocationAuditInput,
} from "./types.js";

const AUDIT_FIELD_MAX_LENGTH = 128;
const SAFE_AUDIT_FIELD = /^[A-Za-z0-9_.:-]+$/;

/** Append one durable MCP invocation event without retaining arguments or results. */
export function recordMcpToolInvocationAudit(
  db: Db,
  input: McpToolInvocationAuditInput,
  now = Date.now(),
): boolean {
  return db.transaction(() => {
    if (input.requireActiveAuthority && !hasActiveAuthority(db, input, now)) return false;
    appendAudit(db, {
      eventType: "mcp-tool-invoked",
      principalId: input.principalId,
      grantId: input.grantId,
      grantRevision: input.grantRevision,
      credentialId: input.credentialId,
      oauthClientId: input.oauthClientId,
      actorTokenId: input.accessTokenId,
      detail: {
        capability: input.capability,
        tool: boundedAuditField(input.tool),
        outcome: input.outcome,
        requestId: boundedAuditField(input.requestId),
        sourceMode: input.sourceMode,
      },
      now,
    });
    return true;
  })();
}

interface AuditRow {
  id: string;
  occurred_at: number;
  event_type: string;
  principal_id: string | null;
  grant_id: string | null;
  grant_revision: number | null;
  credential_id: string | null;
  oauth_client_id: string | null;
  actor_token_id: string | null;
  detail: string;
}

/**
 * The ledger newest first, as a keyset page over (occurred_at, id) so a page
 * boundary holds still while new events land above it. One extra row is read
 * to learn whether a next page exists without counting the table.
 */
export function listAccessAuditEvents(
  db: Db,
  input: AccessAuditListInput,
): { items: AccessAuditEvent[]; hasMore: boolean } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (input.principalId !== undefined) {
    clauses.push("principal_id = ?");
    params.push(input.principalId);
  }
  if (input.grantId !== undefined) {
    clauses.push("grant_id = ?");
    params.push(input.grantId);
  }
  if (input.after) {
    clauses.push("(occurred_at < ? OR (occurred_at = ? AND id < ?))");
    params.push(input.after.occurredAt, input.after.occurredAt, input.after.id);
  }
  const rows = db
    .prepare<Array<string | number>, AuditRow>(
      `SELECT * FROM access_audit_events
       ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params, input.limit + 1);
  const hasMore = rows.length > input.limit;
  return {
    items: (hasMore ? rows.slice(0, input.limit) : rows).map(auditEventFromRow),
    hasMore,
  };
}

function auditEventFromRow(row: AuditRow): AccessAuditEvent {
  let detail: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.detail);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      detail = parsed as Record<string, unknown>;
    }
  } catch {
    // A row whose detail is not an object reads as one with none.
  }
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    eventType: row.event_type,
    principalId: row.principal_id,
    grantId: row.grant_id,
    grantRevision: row.grant_revision,
    credentialId: row.credential_id,
    oauthClientId: row.oauth_client_id,
    actorTokenId: row.actor_token_id,
    detail,
  };
}

/** The writer transaction is the final linearization point before corpus egress. */
function hasActiveAuthority(db: Db, input: McpToolInvocationAuditInput, now: number): boolean {
  return Boolean(
    db
      .prepare<{
        capability: string;
        accessTokenId: string;
        credentialId: string;
        grantRevision: number;
        oauthClientId: string;
        grantId: string;
        principalId: string;
        now: number;
      }>(
        `SELECT 1
         FROM oauth_access_tokens t
         JOIN principal_credentials c ON c.id = t.credential_id
         JOIN access_grants g ON g.id = c.grant_id
         JOIN access_principals p ON p.id = g.principal_id
         JOIN access_grant_capabilities cap
           ON cap.grant_id = g.id AND cap.capability = @capability
         WHERE t.id = @accessTokenId AND t.credential_id = @credentialId
           AND t.grant_revision = @grantRevision
           AND c.id = @credentialId AND c.oauth_client_id = @oauthClientId
           AND g.id = @grantId AND g.principal_id = @principalId AND g.revision = @grantRevision
           AND p.id = @principalId
           AND ${activeAccessTokenPredicate()}`,
      )
      .get({
        capability: input.capability,
        accessTokenId: input.accessTokenId,
        credentialId: input.credentialId,
        grantRevision: input.grantRevision,
        oauthClientId: input.oauthClientId,
        grantId: input.grantId,
        principalId: input.principalId,
        now,
      }),
  );
}

/**
 * Tool and request identifiers are normally short machine identifiers. Hash
 * malformed or oversized values so an external header can never turn the
 * access ledger into storage for arbitrary content.
 */
function boundedAuditField(value: string): string {
  if (value.length > 0 && value.length <= AUDIT_FIELD_MAX_LENGTH && SAFE_AUDIT_FIELD.test(value)) {
    return value;
  }
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
