// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensurePrivateDirSync, writeSecretTextFileSync } from "@omnesis/core";
import {
  DeviceId,
  SCOPE_ADMIN,
  SCOPE_READ,
  SCOPE_WRITE_ALL,
  missingHostedWriteScopes,
  isDeviceKind,
  scopesAllowedForDeviceKind,
  TokenId,
  type DeviceKind,
  type Scope,
} from "@omnesis/types";
import {
  tokensScopesCodec,
  sessionsScopesCodec,
  devicesCapabilitiesCodec,
} from "../json-columns.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashSessionSecret(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function now(): number {
  return Date.now();
}

function serializeTokenScopes(scopes: readonly Scope[]): string {
  return tokensScopesCodec.serialize([...scopes]);
}

function parseTokenScopes(json: string, rowId?: string): Scope[] {
  return tokensScopesCodec.parseWithFallback(json, { rowId });
}

function serializeSessionScopes(scopes: readonly Scope[]): string {
  return sessionsScopesCodec.serialize([...scopes]);
}

function parseSessionScopes(json: string, rowId?: string): Scope[] {
  return sessionsScopesCodec.parseWithFallback(json, { rowId });
}

export interface TokenInfo {
  id: TokenId;
  deviceId: DeviceId;
  name: string | null;
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
}

export interface ValidatedToken {
  id: TokenId;
  deviceId: DeviceId;
  scopes: Scope[];
}

/**
 * Create a token for a device. Returns the raw token (only shown once) and its id.
 * Token format: `omn_` + 32 random hex chars (128 bits of entropy).
 *
 * `opts.ttlMs` sets an expiry `ttlMs` into the future (stored as `expires_at`);
 * omit it for a never-expiring device token. Short-lived callback credentials
 * pass a TTL so `lookupToken` rejects them after the window and the cleanup
 * sweep prunes them.
 */
export function createToken(
  db: Db,
  deviceId: DeviceId,
  scopes: readonly Scope[],
  name: string | null = null,
  opts: { ttlMs?: number } = {},
): { id: TokenId; token: string } {
  const kind = db
    .prepare<[string], { kind: string }>("SELECT kind FROM devices WHERE id = ?")
    .get(deviceId)?.kind;
  if (kind !== undefined && isDeviceKind(kind) && !scopesAllowedForDeviceKind(kind, scopes)) {
    throw new DeviceKindScopeError();
  }
  const id = TokenId(randomUUID());
  const rawToken = `omn_${randomBytes(16).toString("hex")}`;
  const tokenHash = hashToken(rawToken);
  const createdAt = now();
  const expiresAt =
    opts.ttlMs !== undefined && opts.ttlMs > 0 ? createdAt + Math.floor(opts.ttlMs) : null;

  db.prepare(
    `INSERT INTO tokens (id, device_id, token_hash, scopes, name, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, deviceId, tokenHash, serializeTokenScopes(scopes), name, createdAt, expiresAt);

  return { id, token: rawToken };
}

/**
 * A device's kind bounds the scopes its tokens can carry: an integration holds
 * only answer-bounded ones (see `scopesAllowedForDeviceKind`), so the access
 * level it is put on is the whole of what it can read. Callers that can offer
 * a clearer refusal check first; this is the floor every mint shares.
 */
export class DeviceKindScopeError extends Error {
  constructor() {
    super(
      "An integration's tokens can carry only the answer scope (and write scopes); " +
        "what it may read is decided by its access level.",
    );
    this.name = "DeviceKindScopeError";
  }
}

/**
 * Grant a device's token any `write:<source-type>` scope its kind is supposed
 * to hold but doesn't, and return the resulting scope set.
 *
 * Pairing mints scopes from `DEVICE_HOSTED_SOURCE_TYPES` once, at redemption.
 * When a later release teaches the phone app to host a new source, every
 * device paired before that release is missing the new `write:<type>` — and
 * because the offline buffer is strict FIFO, the first rejected batch of that
 * source stalls every batch queued behind it. Re-deriving the grant on each
 * handshake heals those devices in place instead of requiring a re-pair.
 *
 * The grant is derived from the device's `kind`, which only an admin can set at
 * pairing and which no code path lets a device change. Nothing is read from a
 * claim made by the device itself, and `read` / `admin` / `subscriptions:*` are
 * never added.
 *
 * What this does mean, deliberately: per-source write scopes are **not**
 * operator-narrowable. Trimming `write:photos` off a phone token — whether at
 * `devices pair --scopes` or `tokens create --scopes` — is undone on that
 * token's next handshake, because the table says the kind hosts that source. To
 * stop a phone contributing a source, disable the source or revoke the device;
 * do not trim the token.
 */
export function reconcileDeviceTokenScopes(
  db: Db,
  tokenId: TokenId,
  kind: DeviceKind,
): Scope[] | null {
  // Read and write in one transaction. Both statements run inside a single
  // synchronous writer-worker handler today, so nothing can interleave — the
  // transaction keeps that true if this ever moves off the writer thread.
  return db.transaction((): Scope[] | null => {
    const row = db
      .prepare<[string], { scopes: string }>("SELECT scopes FROM tokens WHERE id = ?")
      .get(tokenId);
    if (!row) return null;

    const current = parseTokenScopes(row.scopes, tokenId);
    const missing = missingHostedWriteScopes(current, kind);
    if (missing.length === 0) return current;

    const next = [...current, ...missing];
    db.prepare("UPDATE tokens SET scopes = ? WHERE id = ?").run(
      serializeTokenScopes(next),
      tokenId,
    );
    return next;
  })();
}

/**
 * Pure-read token lookup. Runs on any read-capable handle including the
 * main thread's Phase 3 read-only `omnesis.db` connection. Does NOT update
 * activity timestamps — callers on the HTTP auth hot path should pair this
 * with a fire-and-forget `writer.touchTokenUsage()` so the timestamp
 * update goes through the writer worker without blocking the request.
 *
 * Why this is split: the old `validateToken` did the UPDATE on the same
 * connection as the SELECT. After Phase 2/3 that meant every authed HTTP
 * request postMessage-round-tripped through the writer worker — and every
 * authed request queued behind whichever long write (typically a
 * backfill-worker `refreshSourceStatsRow`, observed at 2.5 s+) happened
 * to be ahead of it.
 */
export function lookupToken(db: Db, rawToken: string): ValidatedToken | null {
  const tokenHash = hashToken(rawToken);
  const row = db
    .prepare<
      [string],
      { id: string; device_id: string; scopes: string; expires_at: number | null }
    >("SELECT id, device_id, scopes, expires_at FROM tokens WHERE token_hash = ?")
    .get(tokenHash);

  if (!row) return null;
  // Reject an expired token (no DELETE here — this runs on the read-only
  // handle; the cleanup sweep prunes the row). Mirrors `lookupSession`.
  if (row.expires_at !== null && row.expires_at < now()) return null;

  return {
    id: TokenId(row.id),
    deviceId: DeviceId(row.device_id),
    scopes: parseTokenScopes(row.scopes, row.id),
  };
}

/**
 * Revalidate an upgrade-time token identity without retaining its raw secret.
 *
 * WebSocket upgrade and application-level hello are separate callbacks. A
 * credential can be revoked between them (notably during device repair), so
 * hello uses this read to ensure cached upgrade authorization is still live.
 */
export function isTokenActive(db: Db, tokenId: TokenId, deviceId: DeviceId): boolean {
  const row = db
    .prepare<
      [string, string],
      { expires_at: number | null }
    >("SELECT expires_at FROM tokens WHERE id = ? AND device_id = ?")
    .get(tokenId, deviceId);
  return !!row && (row.expires_at === null || row.expires_at >= now());
}

/**
 * Update `tokens.last_used_at` + `devices.last_seen_at`. Called via the
 * writer worker from the auth hot path as a fire-and-forget beacon.
 * SQLITE_BUSY is swallowed upstream of this function — missing a
 * heartbeat is fine (matches the old validateToken behaviour).
 */
export function touchTokenUsage(db: Db, tokenId: TokenId, deviceId: DeviceId): void {
  const ts = now();
  db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(ts, tokenId);
  db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(ts, deviceId);
}

/**
 * Batched form of `touchTokenUsage`. Updates `tokens.last_used_at` for
 * every distinct `tokenId` and `devices.last_seen_at` for every
 * distinct `deviceId` in `rows`.
 *
 * Why: the auth flush task used to fan out one writer-worker call per
 * pending token. With N tokens in the buffer that's N round-trips
 * through the writer queue — each one is a small UPDATE but the
 * combined await blocks all other writer work for ~N×ms (observed
 * as `auth.flushTokenUsage exec=6s` slow-op warnings against the
 * 200ms budget).
 *
 * Each row is committed in its own sub-transaction so the writer can
 * yield between rows when a higher-priority task arrives. The
 * previous shape wrapped every row in one outer transaction, which
 * blocked realtime preemption mid-batch (observed: a realtime
 * `db.setSyncError` waited 2.2s behind a 3.5s touchTokenUsageBatch).
 * Per-row commits cost an extra fsync each (~1ms on Apple Silicon
 * SSD) versus the all-in-one form; on a 100-row batch that's ~100ms
 * extra wall-clock in exchange for breaking the writer-park window.
 *
 * Multiple `(tokenId, deviceId)` rows for the same token are fine —
 * the UPDATE is idempotent and the latest timestamp wins. Device IDs
 * are deduped across the batch so a single device seen 50 times
 * triggers one `devices.last_seen_at` UPDATE, not 50.
 *
 * Returns `{ applied, remaining }`. `remaining` is non-empty when the
 * caller-supplied `token.requested()` flipped mid-batch — caller
 * re-enqueues the leftover rows at the same priority so the realtime
 * preemption that interrupted us gets to run.
 */
/**
 * Default sub-transaction size for the batched flush. Chosen so each
 * commit covers a useful chunk of work (amortising the WAL frame +
 * fsync cost across multiple rows) while still letting the writer
 * yield to a higher-priority op within ~50 rows of progress. At
 * Apple Silicon fsync latency (~5-15ms), one commit per 50 rows ≈
 * 1-2ms per row amortised vs ~17ms per row with one-commit-per-row
 * — the difference between a 200-row batch taking ~200ms and ~3.4s.
 */
export const TOUCH_TOKEN_USAGE_CHUNK_SIZE = 50;

export function touchTokenUsageBatch(
  db: Db,
  rows: ReadonlyArray<{ tokenId: TokenId; deviceId: DeviceId }>,
  options: {
    token?: { requested(): boolean };
    chunkSize?: number;
  } = {},
): { applied: number; remaining: ReadonlyArray<{ tokenId: TokenId; deviceId: DeviceId }> } {
  if (rows.length === 0) return { applied: 0, remaining: [] };
  const ts = now();
  const tokenUpdate = db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?");
  const deviceUpdate = db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?");
  const token = options.token;
  const chunkSize = Math.max(1, options.chunkSize ?? TOUCH_TOKEN_USAGE_CHUNK_SIZE);
  const seenDevices = new Set<string>();
  const applyChunk = db.transaction(
    (chunk: ReadonlyArray<{ tokenId: TokenId; deviceId: DeviceId }>) => {
      for (const r of chunk) {
        tokenUpdate.run(ts, r.tokenId);
        if (!seenDevices.has(r.deviceId)) {
          seenDevices.add(r.deviceId);
          deviceUpdate.run(ts, r.deviceId);
        }
      }
    },
  );

  let i = 0;
  while (i < rows.length) {
    const end = Math.min(i + chunkSize, rows.length);
    applyChunk(rows.slice(i, end));
    i = end;
    // Yield poll happens at chunk boundaries: enough fine-grained
    // yielding for sub-second preemption latency on a 200-row batch
    // (4 chunks → 4 yield points) while keeping the fsync count low.
    if (token?.requested() && i < rows.length) break;
  }
  return { applied: i, remaining: rows.slice(i) };
}

/**
 * @deprecated since Phase 2/3 of #192. Use `lookupToken(db, raw)` plus
 * a fire-and-forget `writer.touchTokenUsage(id, deviceId)` instead. This
 * combined form is kept only for tests that still expect the old
 * behaviour on a direct writable handle.
 */
export function validateToken(db: Db, rawToken: string): ValidatedToken | null {
  const info = lookupToken(db, rawToken);
  if (!info) return null;
  try {
    touchTokenUsage(db, info.id, info.deviceId);
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code !== "SQLITE_BUSY") throw err;
  }
  return info;
}

/**
 * Resolve the device a token belongs to, by token id. Portal cookie sessions
 * carry a null deviceId on the request auth context (the hot auth path in
 * server.ts doesn't resolve it), but the session's token is device-bound —
 * `/whoami` uses this to report the device backing a portal session so the
 * UI can pin the "This device" card.
 */
export function deviceIdForToken(db: Db, tokenId: TokenId): DeviceId | null {
  const row = db
    .prepare<[string], { device_id: string }>("SELECT device_id FROM tokens WHERE id = ?")
    .get(tokenId);
  return row ? DeviceId(row.device_id) : null;
}

export function listTokens(db: Db, deviceId?: DeviceId): TokenInfo[] {
  const query = deviceId
    ? db
        .prepare<
          [string],
          {
            id: string;
            device_id: string;
            name: string | null;
            scopes: string;
            created_at: number;
            last_used_at: number | null;
          }
        >(
          "SELECT id, device_id, name, scopes, created_at, last_used_at FROM tokens WHERE device_id = ? ORDER BY created_at ASC",
        )
        .all(deviceId)
    : db
        .prepare<
          [],
          {
            id: string;
            device_id: string;
            name: string | null;
            scopes: string;
            created_at: number;
            last_used_at: number | null;
          }
        >(
          "SELECT id, device_id, name, scopes, created_at, last_used_at FROM tokens ORDER BY created_at ASC",
        )
        .all();

  return query.map((row) => ({
    id: TokenId(row.id),
    deviceId: DeviceId(row.device_id),
    name: row.name,
    scopes: parseTokenScopes(row.scopes, row.id),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

/** Revoke a token by id. Returns true if one was deleted. */
export function revokeToken(db: Db, id: TokenId): boolean {
  const result = db.prepare("DELETE FROM tokens WHERE id = ?").run(id);
  return result.changes > 0;
}

/**
 * Delete every token past its `expires_at` (unix ms). Never-expiring tokens
 * (`expires_at IS NULL`) are untouched. Runs through the writer worker from
 * the periodic cleanup sweep. Short-lived callback credentials can accumulate
 * one row per attempt, so they need pruning.
 */
export function cleanupExpiredTokens(db: Db): number {
  const result = db
    .prepare<[number]>("DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at < ?")
    .run(now());
  return result.changes;
}

export function hasTokens(db: Db): boolean {
  const row = db.prepare<[], { count: number }>("SELECT COUNT(*) as count FROM tokens").get();
  return (row?.count ?? 0) > 0;
}

/**
 * Ensure a bootstrap admin device + token exist on first startup.
 * Writes the raw token to `<configDir>/token`, root-key-wrapped when
 * the install root key already exists and owner-only plaintext otherwise.
 * Returns the raw token if one was created, null if already present.
 */
export function ensureBootstrapToken(db: Db, configDir: string): string | null {
  if (hasTokens(db)) return null;

  // Create a bootstrap device with admin + read + write:* scopes — enough to
  // pair the first real device (typically the operator CLI).
  const deviceId = DeviceId(randomUUID());
  db.prepare(
    `INSERT INTO devices (id, name, kind, capabilities, paired_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(deviceId, "bootstrap", "cli" as DeviceKind, devicesCapabilitiesCodec.serialize({}), now());

  const { token } = createToken(
    db,
    deviceId,
    [SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL],
    "bootstrap",
  );
  const tokenPath = join(configDir, "token");
  ensurePrivateDirSync(configDir);
  writeSecretTextFileSync(tokenPath, token + "\n", { configDir });
  return token;
}

// --- Session management (portal cookie auth) ---

export interface SessionInfo {
  id: string;
  tokenId: TokenId;
  /** The device whose token the session was opened with, whatever its kind. */
  credentialDeviceId: DeviceId;
  portalDeviceId: DeviceId | null;
  scopes: Scope[];
  lastActiveAt: number | null;
}

export function createSession(
  db: Db,
  tokenId: TokenId,
  scopes: readonly Scope[],
  expiresInMs: number = 30 * 24 * 60 * 60 * 1000,
): string {
  const id = randomUUID();
  const rawSessionId = randomUUID();
  const createdAt = now();
  const expiresAt = createdAt + expiresInMs;

  db.prepare(
    `INSERT INTO sessions (id, session_hash, token_id, scopes, created_at, last_active_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    hashSessionSecret(rawSessionId),
    tokenId,
    serializeSessionScopes(scopes),
    createdAt,
    createdAt,
    expiresAt,
  );

  return rawSessionId;
}

export function refreshSessionActivity(
  db: Db,
  sessionId: string,
  sessionTtlMs: number,
  throttleMs: number,
): boolean {
  const timestamp = now();
  const expiresAt = timestamp + sessionTtlMs;
  const refreshBefore = timestamp - throttleMs;
  const result = db
    .prepare(
      `UPDATE sessions
          SET last_active_at = ?, expires_at = ?
        WHERE session_hash = ?
          AND expires_at >= ?
          AND (last_active_at IS NULL OR last_active_at <= ?)`,
    )
    .run(timestamp, expiresAt, hashSessionSecret(sessionId), timestamp, refreshBefore);
  return result.changes > 0;
}

/**
 * Pure-read session lookup. Same split rationale as `lookupToken` — this
 * runs on the main thread's read-only handle so portal auth doesn't
 * queue behind the writer worker. Returns null if the session is
 * expired (no DELETE); the caller should fire-and-forget a
 * `writer.purgeExpiredSession(id)` to prune it.
 */
export function lookupSession(
  db: Db,
  sessionId: string,
): { info: SessionInfo | null; expired: boolean } {
  const row = db
    .prepare<
      [string],
      {
        id: string;
        token_id: string;
        portal_device_id: string | null;
        credential_device_id: string;
        scopes: string;
        last_active_at: number | null;
        expires_at: number;
      }
    >(
      `SELECT s.id,
              s.token_id,
              CASE WHEN d.kind = 'portal' THEN t.device_id ELSE NULL END AS portal_device_id,
              t.device_id AS credential_device_id,
              s.scopes,
              s.last_active_at,
              s.expires_at
         FROM sessions s
         JOIN tokens t ON t.id = s.token_id
         JOIN devices d ON d.id = t.device_id
        WHERE s.session_hash = ?`,
    )
    .get(hashSessionSecret(sessionId));

  if (!row) return { info: null, expired: false };

  if (row.expires_at < now()) {
    return { info: null, expired: true };
  }

  return {
    info: {
      id: row.id,
      tokenId: TokenId(row.token_id),
      portalDeviceId: row.portal_device_id === null ? null : DeviceId(row.portal_device_id),
      credentialDeviceId: DeviceId(row.credential_device_id),
      scopes: parseSessionScopes(row.scopes, row.id),
      lastActiveAt: row.last_active_at,
    },
    expired: false,
  };
}

/**
 * Delete a session only if it's expired. Idempotent — safe to call even
 * if the row was already removed. Runs on the writer worker as a
 * fire-and-forget from the auth path.
 */
export function purgeExpiredSession(db: Db, sessionId: string): void {
  db.prepare("DELETE FROM sessions WHERE session_hash = ? AND expires_at < ?").run(
    hashSessionSecret(sessionId),
    now(),
  );
}

/**
 * @deprecated since Phase 2/3 of #192. Use `lookupSession(db, id)` plus
 * `writer.purgeExpiredSession(id)` instead. Kept for tests that use the
 * direct writable handle form.
 */
export function validateSession(db: Db, sessionId: string): SessionInfo | null {
  const { info, expired } = lookupSession(db, sessionId);
  if (expired) {
    try {
      purgeExpiredSession(db, sessionId);
    } catch {
      /* best-effort */
    }
  }
  return info;
}

export function deleteSession(db: Db, sessionId: string): void {
  db.prepare("DELETE FROM sessions WHERE session_hash = ?").run(hashSessionSecret(sessionId));
}

export function cleanupExpiredSessions(db: Db): number {
  const result = db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now());
  return result.changes;
}
