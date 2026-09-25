// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import {
  claimedNotificationSchema,
  notificationMessageSchema,
  notificationRoute,
  notificationRouteSchema,
  notificationTargetId,
  type NotificationMessage,
  type NotificationRoute,
} from "@omnesis/core/push";
import { DeviceId } from "@omnesis/types";
import type { Db } from "../data/types.js";

export const DEFAULT_NOTIFICATION_LEASE_MS = 30_000;
export const DEFAULT_WAKE_LEASE_MS = 60_000;
const MAX_WAKE_ERROR_LENGTH = 256;

export type NotificationDeliveryState =
  | "pending"
  | "leased"
  | "delivered"
  | "superseded"
  | "expired";

export interface EnqueueNotificationInput {
  message: NotificationMessage;
  deviceIds: readonly DeviceId[];
  createdAt: number;
  expiresAt: number;
}

export interface EnqueueNotificationResult {
  notificationId: string;
  deliveryIds: string[];
  deviceIds: DeviceId[];
}

export type NotificationWakeState = "pending" | "leased" | "sent" | "terminal" | "exhausted";

export interface LeaseNotificationWakesInput {
  now: number;
  leaseMs?: number;
  limit: number;
  maxAttempts: number;
  deviceIds?: readonly DeviceId[];
}

export interface LeasedNotificationWake {
  deliveryId: string;
  deviceId: DeviceId;
  leaseToken: string;
  attempt: number;
  expiresAt: number;
}

export type SettleNotificationWakeInput = {
  leaseToken: string;
  now: number;
  transport: string;
} & (
  | { outcome: "sent" }
  | { outcome: "terminal"; reason: string }
  | { outcome: "retry"; reason: string; nextAttemptAt: number; maxAttempts: number }
);

export interface WatchNotificationWakeOutcome {
  watchId: string;
  firingKey: string;
  firingId: string;
  attempted: number;
  delivered: number;
  outstanding: number;
  failed: number;
}

interface WatchNotificationWakeOutcomeRow {
  route_data: string | null;
  attempted: number;
  delivered: number;
  outstanding: number;
  failed: number;
}

export function validateEnqueueNotificationInput(input: EnqueueNotificationInput): void {
  notificationMessageSchema.parse(input.message);
  if (!Number.isSafeInteger(input.createdAt) || !Number.isSafeInteger(input.expiresAt)) {
    throw new Error("notification timestamps must be safe integers");
  }
  if (input.expiresAt <= input.createdAt) {
    throw new Error("notification expiry must be after creation");
  }
}

export interface ClaimedNotificationDelivery {
  id: string;
  kind: NotificationMessage["kind"];
  targetId: string;
  affectedDeviceId?: string;
  sourceName?: string;
  affectedDeviceName?: string;
  title: string;
  body: string;
  collapseId: string;
  remaining: number;
  route?: NotificationRoute;
}

export interface ClaimNotificationInput {
  deviceId: DeviceId;
  now: number;
  leaseMs?: number;
}

export interface ConfirmNotificationInput {
  deviceId: DeviceId;
  deliveryId: string;
  now: number;
}

/**
 * Cancel every delivery still owed to one device — pending or leased, with
 * its wake — regardless of what the notifications were about. Used when the
 * device is revoked: nothing it was going to be told can reach it anymore.
 */
export function supersedeDeliveriesForDevice(db: Db, deviceId: string): number {
  return db
    .prepare(
      `UPDATE notification_deliveries
          SET state = 'superseded', leased_until = NULL,
              wake_state = 'terminal', wake_lease_token = NULL,
              wake_leased_until = NULL, wake_next_attempt_at = NULL
        WHERE device_id = ? AND (state = 'pending' OR state = 'leased')`,
    )
    .run(deviceId).changes;
}

/** Cancel all episodes for one bounded, hashed source collapse prefix. */
export function supersedeNotificationsByCollapseIdPrefix(
  db: Db,
  collapseIdPrefix: string,
  _now: number,
): number {
  return db
    .prepare(
      `UPDATE notification_deliveries
          SET state = 'superseded', leased_until = NULL,
              wake_state = 'terminal', wake_lease_token = NULL,
              wake_leased_until = NULL, wake_next_attempt_at = NULL
        WHERE notification_id IN (
          SELECT id FROM notifications WHERE substr(collapse_id, 1, ?) = ?
        ) AND (state = 'pending' OR state = 'leased')`,
    )
    .run(collapseIdPrefix.length, collapseIdPrefix).changes;
}

interface ClaimedRow {
  lease_token: string;
  kind: string;
  target_id: string;
  title: string;
  body: string;
  collapse_id: string;
  route_data: string | null;
}

/** Install the current queue shape for fresh databases and migration replay. */
export function createNotificationQueueTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      route_data TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      collapse_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_collapse
      ON notifications(collapse_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_expiry
      ON notifications(expires_at);

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id TEXT PRIMARY KEY,
      notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'delivered', 'superseded', 'expired')),
      lease_token TEXT UNIQUE,
      leased_until INTEGER,
      claimed_at INTEGER,
      delivered_at INTEGER,
      wake_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (wake_state IN ('pending', 'leased', 'sent', 'terminal', 'exhausted')),
      wake_attempt_count INTEGER NOT NULL DEFAULT 0,
      wake_lease_token TEXT UNIQUE,
      wake_leased_until INTEGER,
      wake_next_attempt_at INTEGER,
      wake_last_attempt_at INTEGER,
      wake_last_success_at INTEGER,
      wake_last_error TEXT,
      wake_last_transport TEXT,
      UNIQUE(notification_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_claim
      ON notification_deliveries(device_id, state, leased_until, notification_id);
  `);
  const deliveryColumns = new Set(
    db
      .prepare<[], { name: string }>(
        "SELECT name FROM pragma_table_info('notification_deliveries')",
      )
      .all()
      .map((row) => row.name),
  );
  // Existing installs reach this helper before migrations. Only build the
  // head indexes when the corresponding head columns already exist.
  if (deliveryColumns.has("wake_state")) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_deliveries_wake_token
        ON notification_deliveries(wake_lease_token)
        WHERE wake_lease_token IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_notification_deliveries_wake_due
        ON notification_deliveries(wake_state, wake_next_attempt_at, wake_leased_until,
                                   wake_attempt_count, device_id);
    `);
  }
}

/**
 * Render once, fan out once, and supersede older unclaimed collapse peers per
 * device. An active lease is never revoked: its client already has the text.
 */
export function enqueueNotification(
  db: Db,
  input: EnqueueNotificationInput,
): EnqueueNotificationResult | null {
  validateEnqueueNotificationInput(input);
  const message = input.message;
  const deviceIds = [...new Set(input.deviceIds)];
  if (deviceIds.length === 0) return null;

  const transaction = db.transaction((): EnqueueNotificationResult | null => {
    const hasDevice = db.prepare<[string], { present: number }>(
      "SELECT 1 AS present FROM devices WHERE id = ?",
    );
    const existingDeviceIds = deviceIds.filter((deviceId) => hasDevice.get(deviceId) !== undefined);
    if (existingDeviceIds.length === 0) return null;

    const notificationId = randomUUID();
    db.prepare(
      `INSERT INTO notifications
         (id, kind, target_id, route_data, title, body, collapse_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      notificationId,
      message.kind,
      notificationTargetId(message),
      JSON.stringify(notificationRoute(message)),
      message.title,
      message.body,
      message.collapseId,
      input.createdAt,
      input.expiresAt,
    );

    const supersede = db.prepare(
      `UPDATE notification_deliveries
          SET state = 'superseded', leased_until = NULL,
              wake_state = 'terminal', wake_lease_token = NULL,
              wake_leased_until = NULL, wake_next_attempt_at = NULL
        WHERE device_id = ?
          AND notification_id IN (
            SELECT id FROM notifications
             WHERE collapse_id = ? AND id <> ?
          )
          AND (
            state = 'pending'
            OR (state = 'leased' AND leased_until <= ?)
          )`,
    );
    const insertDelivery = db.prepare(
      `INSERT INTO notification_deliveries
         (id, notification_id, device_id, state, wake_state, wake_next_attempt_at)
       VALUES (?, ?, ?, 'pending', 'pending', ?)`,
    );
    const deliveryIds: string[] = [];
    for (const deviceId of existingDeviceIds) {
      supersede.run(deviceId, message.collapseId, notificationId, input.createdAt);
      const deliveryId = randomUUID();
      insertDelivery.run(deliveryId, notificationId, deviceId, input.createdAt);
      deliveryIds.push(deliveryId);
    }
    return { notificationId, deliveryIds, deviceIds: existingDeviceIds };
  });

  return transaction.immediate();
}

/**
 * Atomically lease due content-free wakes. A lease token is the only authority
 * accepted by settlement, so overlapping scheduler ticks and process restarts
 * cannot concurrently own the same delivery.
 */
export function leaseNotificationWakes(
  db: Db,
  input: LeaseNotificationWakesInput,
): LeasedNotificationWake[] {
  const leaseMs = input.leaseMs ?? DEFAULT_WAKE_LEASE_MS;
  if (
    !Number.isSafeInteger(input.now) ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs <= 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    !Number.isSafeInteger(input.maxAttempts) ||
    input.maxAttempts <= 0 ||
    !Number.isSafeInteger(input.now + leaseMs)
  ) {
    throw new Error("wake lease inputs must be positive safe integers");
  }
  const deviceIds = input.deviceIds ? [...new Set(input.deviceIds)] : undefined;
  if (deviceIds?.length === 0) return [];

  return db
    .transaction((): LeasedNotificationWake[] => {
      expireNotificationsInTransaction(db, input.now);
      db.prepare(
        `UPDATE notification_deliveries
            SET wake_state = 'exhausted', wake_next_attempt_at = NULL
          WHERE wake_state = 'pending' AND wake_attempt_count >= ?`,
      ).run(input.maxAttempts);
      db.prepare(
        `UPDATE notification_deliveries
            SET wake_state = 'exhausted', wake_lease_token = NULL, wake_leased_until = NULL,
                wake_next_attempt_at = NULL
          WHERE wake_state = 'leased'
            AND wake_leased_until <= ?
            AND wake_attempt_count >= ?`,
      ).run(input.now, input.maxAttempts);

      const targetClause = deviceIds
        ? ` AND d.device_id IN (${deviceIds.map(() => "?").join(",")})`
        : "";
      const candidates = db
        .prepare<unknown[], { delivery_id: string; device_id: string; expires_at: number }>(
          `WITH due AS (
             SELECT d.id AS delivery_id, d.device_id, n.expires_at,
                    COALESCE(d.wake_next_attempt_at, 0) AS due_at,
                    n.created_at,
                    d.rowid AS delivery_rowid,
                    ROW_NUMBER() OVER (
                      PARTITION BY d.device_id
                      ORDER BY COALESCE(d.wake_next_attempt_at, 0), n.created_at, d.rowid
                    ) AS device_rank
               FROM notification_deliveries d
               JOIN notifications n ON n.id = d.notification_id
              WHERE n.expires_at > ?
                AND (
                  d.state = 'pending'
                  OR (d.state = 'leased' AND d.leased_until <= ?)
                )
                AND d.wake_attempt_count < ?
                AND (
                  (d.wake_state = 'pending' AND COALESCE(d.wake_next_attempt_at, 0) <= ?)
                  OR (d.wake_state = 'leased' AND d.wake_leased_until <= ?)
                )${targetClause}
           )
           SELECT delivery_id, device_id, expires_at
             FROM due
            WHERE device_rank = 1
            ORDER BY due_at, created_at, delivery_rowid
            LIMIT ?`,
        )
        .all(
          input.now,
          input.now,
          input.maxAttempts,
          input.now,
          input.now,
          ...(deviceIds ?? []),
          input.limit,
        );

      const leaseUntil = input.now + leaseMs;
      const update = db.prepare(
        `UPDATE notification_deliveries
            SET wake_state = 'leased', wake_lease_token = ?, wake_leased_until = ?,
                wake_next_attempt_at = NULL, wake_attempt_count = wake_attempt_count + 1,
                wake_last_attempt_at = ?
          WHERE id = ?
            AND wake_attempt_count < ?
            AND (
              (wake_state = 'pending' AND COALESCE(wake_next_attempt_at, 0) <= ?)
              OR (wake_state = 'leased' AND wake_leased_until <= ?)
            )`,
      );
      const leased: LeasedNotificationWake[] = [];
      for (const candidate of candidates) {
        const leaseToken = randomUUID();
        const result = update.run(
          leaseToken,
          leaseUntil,
          input.now,
          candidate.delivery_id,
          input.maxAttempts,
          input.now,
          input.now,
        );
        if (result.changes !== 1) continue;
        const attempt = db
          .prepare<
            [string],
            { wake_attempt_count: number }
          >("SELECT wake_attempt_count FROM notification_deliveries WHERE id = ?")
          .get(candidate.delivery_id)!.wake_attempt_count;
        leased.push({
          deliveryId: candidate.delivery_id,
          deviceId: DeviceId(candidate.device_id),
          leaseToken,
          attempt,
          expiresAt: candidate.expires_at,
        });
      }
      return leased;
    })
    .immediate();
}

/** Settle exactly the current wake lease; stale or duplicated tokens are no-ops. */
export function settleNotificationWake(db: Db, input: SettleNotificationWakeInput): boolean {
  if (!Number.isSafeInteger(input.now)) throw new Error("wake settlement time must be safe");
  if (
    input.outcome === "retry" &&
    (!Number.isSafeInteger(input.nextAttemptAt) ||
      !Number.isSafeInteger(input.maxAttempts) ||
      input.maxAttempts <= 0)
  ) {
    throw new Error("wake retry settlement values must be positive safe integers");
  }

  return db
    .transaction((): boolean => {
      const leased = db
        .prepare<[string], { wake_attempt_count: number }>(
          `SELECT wake_attempt_count
             FROM notification_deliveries
            WHERE wake_lease_token = ? AND wake_state = 'leased'`,
        )
        .get(input.leaseToken);
      if (!leased) return false;

      let state: NotificationWakeState;
      let nextAttemptAt: number | null = null;
      let error: string | null = null;
      let successAt: number | null = null;
      switch (input.outcome) {
        case "sent":
          state = "sent";
          successAt = input.now;
          break;
        case "terminal":
          state = "terminal";
          error = normalizeWakeError(input.reason);
          break;
        case "retry":
          state = leased.wake_attempt_count >= input.maxAttempts ? "exhausted" : "pending";
          nextAttemptAt = state === "pending" ? input.nextAttemptAt : null;
          error = normalizeWakeError(input.reason);
          break;
        default:
          return assertNeverWakeOutcome(input);
      }

      const result = db
        .prepare(
          `UPDATE notification_deliveries
              SET wake_state = ?, wake_lease_token = NULL, wake_leased_until = NULL,
                  wake_next_attempt_at = ?, wake_last_success_at = COALESCE(?, wake_last_success_at),
                  wake_last_error = ?, wake_last_transport = ?
            WHERE wake_lease_token = ? AND wake_state = 'leased'`,
        )
        .run(state, nextAttemptAt, successAt, error, input.transport, input.leaseToken);
      return result.changes === 1;
    })
    .immediate();
}

function assertNeverWakeOutcome(value: never): never {
  throw new Error(`unknown wake outcome: ${String(value)}`);
}

function normalizeWakeError(reason: string): string {
  let normalized = "";
  for (const character of reason) {
    const code = character.charCodeAt(0);
    normalized += code <= 0x1f || code === 0x7f ? " " : character;
  }
  return normalized.trim().slice(0, MAX_WAKE_ERROR_LENGTH);
}

/** Read durable wake state for one watch, keyed by the firing's full identity. */
export function watchNotificationWakeOutcomes(
  db: Db,
  watchId: string,
  now: number = Date.now(),
): Map<string, WatchNotificationWakeOutcome> {
  return readWatchNotificationWakeOutcomes(db, now, watchId).get(watchId) ?? new Map();
}

/** Read every retained watch outcome with one bounded history scan per retry sweep. */
export function allWatchNotificationWakeOutcomes(
  db: Db,
  now: number = Date.now(),
): Map<string, Map<string, WatchNotificationWakeOutcome>> {
  return readWatchNotificationWakeOutcomes(db, now);
}

function readWatchNotificationWakeOutcomes(
  db: Db,
  now: number,
  watchId?: string,
): Map<string, Map<string, WatchNotificationWakeOutcome>> {
  const watchFilter = watchId ? " AND json_extract(n.route_data, '$.watchId') = ?" : "";
  const rows = db
    .prepare<unknown[], WatchNotificationWakeOutcomeRow>(
      `SELECT n.route_data,
              COALESCE(SUM(d.wake_attempt_count), 0) AS attempted,
              SUM(CASE WHEN d.wake_state = 'sent' THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN n.expires_at > ? AND d.wake_state IN ('pending', 'leased')
                       THEN 1 ELSE 0 END) AS outstanding,
              SUM(CASE WHEN (d.wake_state IN ('terminal', 'exhausted')
                                  AND d.state <> 'superseded')
                            OR (n.expires_at <= ? AND d.wake_state IN ('pending', 'leased'))
                       THEN 1 ELSE 0 END) AS failed
        FROM notifications n
         JOIN notification_deliveries d ON d.notification_id = n.id
        WHERE n.kind = 'watch'
          AND json_valid(n.route_data)${watchFilter}
        GROUP BY n.id`,
    )
    .all(now, now, ...(watchId ? [watchId] : []));
  const outcomesByWatch = new Map<string, Map<string, WatchNotificationWakeOutcome>>();
  for (const row of rows) {
    if (!row.route_data) continue;
    let route: unknown;
    try {
      route = JSON.parse(row.route_data);
    } catch {
      continue;
    }
    const parsed = notificationRouteSchema.safeParse(route);
    if (!parsed.success || parsed.data.kind !== "watch") continue;
    if ((watchId && parsed.data.watchId !== watchId) || !parsed.data.firingId) continue;
    let outcomes = outcomesByWatch.get(parsed.data.watchId);
    if (!outcomes) {
      outcomes = new Map();
      outcomesByWatch.set(parsed.data.watchId, outcomes);
    }
    const current = outcomes.get(parsed.data.firingId);
    outcomes.set(parsed.data.firingId, {
      watchId: parsed.data.watchId,
      firingKey: parsed.data.firingKey,
      firingId: parsed.data.firingId,
      attempted: (current?.attempted ?? 0) + row.attempted,
      delivered: (current?.delivered ?? 0) + row.delivered,
      outstanding: (current?.outstanding ?? 0) + row.outstanding,
      failed: (current?.failed ?? 0) + row.failed,
    });
  }
  return outcomesByWatch;
}

/**
 * Two of the three statements a `/notifications/claim` runs against one
 * device's retained delivery history, inside a single writer transaction.
 *
 * `idx_notification_deliveries_claim` is `(device_id, state, leased_until,
 * notification_id)`, and the `state` column is what keeps a claim proportional
 * to what the device still owes rather than to everything it has ever been
 * sent — deliveries are retained for the notification's full TTL, so on a busy
 * phone the terminal `delivered` / `superseded` / `expired` rows outnumber the
 * actionable ones by orders of magnitude.
 *
 * Writing the actionable set as a bare `state = 'pending' OR (state = 'leased'
 * AND leased_until <= ?)` does not reach that column: SQLite can only turn an
 * OR into two index seeks through its cost-based multi-index-OR optimization,
 * and the gateway never runs ANALYZE, so with no `sqlite_stat1` the planner
 * falls back to `(device_id=?)` alone and walks every row the device holds.
 * Naming the two states in an `IN` list constrains the index prefix
 * unconditionally, leaving the disjunction as a filter over the rows that
 * survive it. The statements are exported so the plan regression test in
 * `queue.test.ts` can EXPLAIN exactly this text; `expireDeliveriesSql` is the
 * third.
 */
export const CLAIM_CANDIDATE_SQL = `SELECT d.id AS delivery_id
   FROM notification_deliveries d
   JOIN notifications n ON n.id = d.notification_id
  WHERE d.device_id = ?
    AND d.state IN ('pending', 'leased')
    AND n.expires_at > ?
    AND (d.state = 'pending' OR d.leased_until <= ?)
  ORDER BY n.created_at ASC, n.rowid ASC, d.rowid ASC
  LIMIT 1`;

/** @see CLAIM_CANDIDATE_SQL — same predicate, counting the whole backlog. */
export const PENDING_COUNT_SQL = `SELECT COUNT(*) AS count
     FROM notification_deliveries d
     JOIN notifications n ON n.id = d.notification_id
    WHERE d.device_id = ?
      AND d.state IN ('pending', 'leased')
      AND n.expires_at > ?
      AND (d.state = 'pending' OR d.leased_until <= ?)`;

/** Atomically lease the oldest actionable delivery for one paired device. */
export function claimNotification(
  db: Db,
  input: ClaimNotificationInput,
): ClaimedNotificationDelivery | null {
  const leaseMs = input.leaseMs ?? DEFAULT_NOTIFICATION_LEASE_MS;
  if (!Number.isSafeInteger(input.now) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new Error("notification claim time and lease must be positive safe integers");
  }
  if (!Number.isSafeInteger(input.now + leaseMs)) {
    throw new Error("notification lease deadline must be a safe integer");
  }

  const transaction = db.transaction((): ClaimedNotificationDelivery | null => {
    expireNotificationsInTransaction(db, input.now, input.deviceId);
    const candidate = db
      .prepare<[string, number, number], { delivery_id: string }>(CLAIM_CANDIDATE_SQL)
      .get(input.deviceId, input.now, input.now);
    if (!candidate) return null;

    const leasedUntil = input.now + leaseMs;
    const claimToken = randomUUID();
    const updated = db
      .prepare(
        `UPDATE notification_deliveries
            SET state = 'leased', lease_token = ?, leased_until = ?, claimed_at = ?,
                wake_state = 'sent', wake_lease_token = NULL,
                wake_leased_until = NULL, wake_next_attempt_at = NULL,
                wake_last_success_at = COALESCE(wake_last_success_at, ?)
          WHERE id = ?
            AND device_id = ?
            AND (state = 'pending' OR (state = 'leased' AND leased_until <= ?))`,
      )
      .run(
        claimToken,
        leasedUntil,
        input.now,
        input.now,
        candidate.delivery_id,
        input.deviceId,
        input.now,
      );
    if (updated.changes !== 1) return null;

    const row = db
      .prepare<[string], ClaimedRow>(
        `SELECT d.lease_token, n.kind, n.target_id, n.route_data, n.title, n.body, n.collapse_id
           FROM notification_deliveries d
           JOIN notifications n ON n.id = d.notification_id
          WHERE d.id = ?`,
      )
      .get(candidate.delivery_id);
    if (!row) throw new Error(`leased notification delivery vanished: ${candidate.delivery_id}`);

    const route: unknown = row.route_data ? JSON.parse(row.route_data) : undefined;
    const affectedDeviceId =
      row.kind === "source-permission" &&
      typeof route === "object" &&
      route !== null &&
      "affectedDeviceId" in route
        ? (route as { affectedDeviceId?: unknown }).affectedDeviceId
        : undefined;
    const sourceName =
      row.kind === "source-permission" &&
      typeof route === "object" &&
      route !== null &&
      "sourceName" in route
        ? (route as { sourceName?: unknown }).sourceName
        : undefined;
    const affectedDeviceName =
      row.kind === "source-permission" &&
      typeof route === "object" &&
      route !== null &&
      "affectedDeviceName" in route
        ? (route as { affectedDeviceName?: unknown }).affectedDeviceName
        : undefined;

    const claimed = claimedNotificationSchema.parse({
      id: row.lease_token,
      kind: row.kind,
      targetId: row.target_id,
      ...(typeof affectedDeviceId === "string" ? { affectedDeviceId } : {}),
      ...(typeof sourceName === "string" ? { sourceName } : {}),
      ...(typeof affectedDeviceName === "string" ? { affectedDeviceName } : {}),
      title: row.title,
      body: row.body,
      collapseId: row.collapse_id,
      remaining: pendingNotificationCount(db, input.deviceId, input.now),
      ...(route === undefined ? {} : { route }),
    });
    return claimed;
  });

  return transaction.immediate();
}

/** Confirm only a lease belonging to the authenticated device. */
export function confirmNotification(db: Db, input: ConfirmNotificationInput): boolean {
  if (!Number.isSafeInteger(input.now)) throw new Error("confirmation time must be a safe integer");
  const result = db
    .prepare(
      `UPDATE notification_deliveries
          SET state = 'delivered', leased_until = NULL, delivered_at = ?,
              wake_state = 'sent', wake_lease_token = NULL,
              wake_leased_until = NULL, wake_next_attempt_at = NULL,
              wake_last_success_at = COALESCE(wake_last_success_at, ?)
        WHERE lease_token = ? AND device_id = ? AND state = 'leased'`,
    )
    .run(input.now, input.now, input.deliveryId, input.deviceId);
  return result.changes === 1;
}

/** Expire pending work and leases whose clients have no remaining claim. */
export function expireNotifications(db: Db, now: number, deviceId?: DeviceId): number {
  if (!Number.isSafeInteger(now))
    throw new Error("notification expiry time must be a safe integer");
  const transaction = db.transaction(() => expireNotificationsInTransaction(db, now, deviceId));
  return transaction.immediate().deliveriesExpired;
}

/** Globally remove expired private content without disturbing a live lease. */
export function cleanupExpiredNotifications(db: Db, now: number): number {
  if (!Number.isSafeInteger(now))
    throw new Error("notification expiry time must be a safe integer");
  const transaction = db.transaction(() => expireNotificationsInTransaction(db, now));
  return transaction.immediate().notificationsDeleted;
}

/**
 * The expiry pass a claim runs before looking for a candidate.
 *
 * @see CLAIM_CANDIDATE_SQL — `state IN (...)` is load-bearing here for the
 * same reason. On the device-scoped call it is what constrains
 * `idx_notification_deliveries_claim` past its `device_id` prefix; without it
 * the planner walks every delivery the device has ever been sent, inside the
 * claim's own writer transaction.
 */
export function expireDeliveriesSql(deviceScoped: boolean): string {
  return `UPDATE notification_deliveries
      SET state = 'expired', leased_until = NULL,
          wake_state = 'terminal', wake_lease_token = NULL,
          wake_leased_until = NULL, wake_next_attempt_at = NULL
    WHERE notification_id IN (SELECT id FROM notifications WHERE expires_at <= ?)
      AND state IN ('pending', 'leased')
      AND (state = 'pending' OR leased_until <= ?)${deviceScoped ? " AND device_id = ?" : ""}`;
}

function expireNotificationsInTransaction(
  db: Db,
  now: number,
  deviceId?: DeviceId,
): { deliveriesExpired: number; notificationsDeleted: number } {
  const params: Array<string | number> = [now, now];
  if (deviceId !== undefined) params.push(deviceId);
  const result = db.prepare(expireDeliveriesSql(deviceId !== undefined)).run(...params);
  const deleted = db
    .prepare(
      `DELETE FROM notifications
      WHERE expires_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries d
           WHERE d.notification_id = notifications.id
             AND d.state = 'leased'
             AND d.leased_until > ?
        )`,
    )
    .run(now, now);
  return { deliveriesExpired: result.changes, notificationsDeleted: deleted.changes };
}

export function pendingNotificationCount(db: Db, deviceId: DeviceId, now: number): number {
  return db
    .prepare<[string, number, number], { count: number }>(PENDING_COUNT_SQL)
    .get(deviceId, now, now)!.count;
}
