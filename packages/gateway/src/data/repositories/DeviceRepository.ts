// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createLogger } from "@omnesis/core";
import {
  DeviceId,
  SourceType,
  SCOPE_SUBSCRIPTIONS_MANAGE,
  SCOPE_SUBSCRIPTIONS_RECEIVE,
  isDeviceKind,
  isPushTransport,
  isValidScope,
  tryDeviceId,
  scopesAllowedForDeviceKind,
  writeScope,
  type ApnsRegistration,
  type DeviceCapability,
  type DeviceKind,
  type DeviceRecord,
  type FcmRegistration,
  isDeviceUpdateState,
  type DeviceUpdateState,
  type NotificationDeliveryHealth,
  type PushTransport,
  type Scope,
  type SourceId,
} from "@omnesis/types";
import { devicesCapabilitiesCodec, devicePairingsScopesCodec } from "../json-columns.js";
import { markPeopleGraphDirty } from "../DirtyMarks.js";
import { putPairedIntegrationOnLevel } from "../../access/store-levels.js";
import { extendUnanimousMemberConfigContracts } from "./SourceMemberConfigContractRepository.js";
import { aliasWriter } from "./PersonAliasRepository.js";
import { createToken, DeviceKindScopeError } from "./TokenRepository.js";
import type BetterSqlite3 from "better-sqlite3";

type Db = BetterSqlite3.Database;

const log = createLogger("gateway").child("devices");
const PAIRING_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const GCM_TAG_BYTES = 16;

/**
 * Pick the name for a device being paired in for the first time. A re-pair
 * adopts an existing row and keeps that row's name (see
 * `createOrReplaceDeviceForPair`); the name is display only.
 *
 * Precedence: admin-supplied on the pairing code > device-supplied
 * `capabilities.suggestedName` at redeem > generated fallback. The
 * empty-string rung exists because the `device_pairings.name` column is
 * `TEXT NOT NULL` — the admin "no name" case is encoded as an empty string
 * rather than NULL.
 *
 * The `portal` rung is a fallback for a cached portal SPA that redeems
 * without sending a name — it lands on one shared `portal` device row. The
 * portal SPA and browser extension each mint a stable, unique-per-install
 * `suggestedName` (persisted client-side) alongside their install identity,
 * so distinct browsers land on distinct rows.
 */
export function resolveDeviceName(
  pendingName: string,
  kind: DeviceKind,
  capabilities: DeviceCapability,
): string {
  const adminName = pendingName.trim();
  if (adminName) return adminName;
  const suggested = (capabilities.suggestedName ?? "").trim();
  if (suggested) return suggested;
  if (kind === "portal") return "portal";
  const slug = randomBytes(4).toString("hex");
  return `${kind}-${slug}`;
}

function now(): number {
  return Date.now();
}

/**
 * The capabilities a row stores. Three declarations are hoisted out of the
 * bag into columns of their own: the client's install identity
 * (`install_id`), the product version it reports (`version`, which the
 * version ledger reads and orders), and `previousDeviceId`, a pair-time
 * adoption hint rather than a capability at all.
 */
function storedCapabilities(caps: DeviceCapability): DeviceCapability {
  const {
    installId: _installId,
    previousDeviceId: _previousDeviceId,
    version: _version,
    ...stored
  } = caps;
  return stored;
}

/**
 * The product version a client declared, or null when it declared none. A
 * client built before the version ledger sends nothing here, which is a
 * supported state — the device reads as "unknown", never as a fault.
 */
export function versionFrom(caps: DeviceCapability): string | null {
  const raw = caps.version?.trim();
  return raw ? raw : null;
}

function serializeCapabilities(caps: DeviceCapability): string {
  return devicesCapabilitiesCodec.serialize(storedCapabilities(caps) as Record<string, unknown>);
}

function parseCapabilities(json: string | null, rowId?: string): DeviceCapability {
  if (!json) return {};
  return devicesCapabilitiesCodec.parseWithFallback(json, { rowId }) as DeviceCapability;
}

function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

export function createDevice(
  db: Db,
  opts: {
    name: string;
    kind: DeviceKind;
    capabilities?: DeviceCapability;
  },
): DeviceRecord {
  if (!isDeviceKind(opts.kind)) {
    throw new Error(`Invalid device kind: ${opts.kind}`);
  }
  if (!opts.name || typeof opts.name !== "string") {
    throw new Error("Device name is required");
  }

  const id = DeviceId(randomUUID());
  const caps = opts.capabilities ?? {};
  const pairedAt = now();

  const installId = installIdFrom(caps);
  // A client that never opens a device socket (the browser extension pairs
  // and pushes over HTTP) reports its version here or nowhere, so the pair
  // path stamps the ledger just as the hello does.
  const version = versionFrom(caps);
  db.prepare(
    `INSERT INTO devices (id, name, kind, capabilities, paired_at, install_id, version, version_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.name,
    opts.kind,
    serializeCapabilities(caps),
    pairedAt,
    installId,
    version,
    version ? pairedAt : null,
  );

  return {
    id,
    name: opts.name,
    kind: opts.kind,
    capabilities: storedCapabilities(caps),
    version,
    versionSeenAt: version ? pairedAt : null,
    protocolVersion: null,
    accessLevelId: null,
    pairedAt,
    lastSeenAt: null,
    revokedAt: null,
    installId,
    selfEmails: [],
    selfPhones: [],
    apnsRegistration: null,
    fcmRegistration: null,
    pushTransport: null,
    relayUrl: null,
    relayCredential: null,
    relayConsent: null,
    notificationDeliveryHealth: null,
    notificationDeliveryHealthUpdatedAt: null,
    desiredVersion: null,
    updateState: null,
    updateDetail: null,
    updateStateAt: null,
  };
}

/**
 * Revoke a device: its tokens and push registrations are invalidated, the
 * row stays. The id is a durable identity (per-device cursors, partitioned
 * stream keys), so unpairing never deletes it — pairing the same device
 * again adopts the row via `replaceDeviceForRepair` (by install identity,
 * or by name for clients without one). Source memberships
 * and `sources.device_id` are kept as well: the sources go dormant, and a
 * re-pair finds them still attached. Principal credentials whose execution
 * identity is this device are revoked in the same transaction, so an agent
 * unpair also ends that installation's corpus access. Returns false when the
 * device doesn't exist.
 */
export function revokeDevice(db: Db, id: DeviceId): boolean {
  const tx = db.transaction(() => {
    const exists =
      db.prepare<[string], { id: string }>("SELECT id FROM devices WHERE id = ?").get(id) !==
      undefined;
    if (!exists) return false;
    const revokedAt = now();
    // Same push-registration reset as a repair: a revoked phone must drop
    // out of every notification target set, not just lose HTTP/WS access.
    // An outstanding update request goes with them — nothing runs on a
    // revoked device, so a version it was asked to reach is no longer owed.
    db.prepare(
      `UPDATE devices
          SET revoked_at = COALESCE(revoked_at, ?),
              apns_device_token = NULL, apns_environment = NULL,
              apns_bundle_id = NULL, apns_token_updated_at = NULL,
              fcm_registration_token = NULL, fcm_token_updated_at = NULL,
              push_transport = NULL, relay_url = NULL, relay_credential = NULL,
              relay_consent_app_id = NULL, relay_consented_at = NULL,
              notification_delivery_health = NULL,
              notification_delivery_health_updated_at = NULL,
              desired_version = NULL, update_state = NULL,
              update_detail = NULL, update_state_at = NULL
        WHERE id = ?`,
    ).run(revokedAt, id);
    // An integration-bound principal credential is meaningful only while its
    // operational device is trusted. Revocation and deletion must therefore
    // have the same effect on corpus authority.
    db.prepare(
      `UPDATE principal_credentials
          SET revoked_at = COALESCE(revoked_at, ?)
        WHERE execution_device_id = ?`,
    ).run(revokedAt, id);
    db.prepare("DELETE FROM tokens WHERE device_id = ?").run(id);
    return true;
  });
  return tx.immediate();
}

interface DeviceRow {
  id: string;
  name: string;
  kind: string;
  capabilities: string;
  paired_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  install_id: string | null;
  self_emails: string;
  self_phones: string;
  access_level_id: string | null;
  apns_device_token: string | null;
  apns_environment: string | null;
  apns_bundle_id: string | null;
  apns_token_updated_at: number | null;
  fcm_registration_token: string | null;
  fcm_token_updated_at: number | null;
  push_transport: string | null;
  relay_url: string | null;
  relay_credential: string | null;
  relay_consent_app_id: string | null;
  relay_consented_at: number | null;
  notification_delivery_health: string | null;
  notification_delivery_health_updated_at: number | null;
  version: string | null;
  version_seen_at: number | null;
  protocol_version: number | null;
  desired_version: string | null;
  update_state: string | null;
  update_detail: string | null;
  update_state_at: number | null;
}

const DEVICE_SELECT_COLS =
  "id, name, kind, capabilities, paired_at, last_seen_at, revoked_at, install_id, self_emails, self_phones, access_level_id, " +
  "apns_device_token, apns_environment, apns_bundle_id, apns_token_updated_at, " +
  "fcm_registration_token, fcm_token_updated_at, push_transport, relay_url, relay_credential, " +
  "relay_consent_app_id, relay_consented_at, " +
  "notification_delivery_health, notification_delivery_health_updated_at, " +
  "version, version_seen_at, protocol_version, " +
  "desired_version, update_state, update_detail, update_state_at";

export function getDevice(db: Db, id: DeviceId): DeviceRecord | null {
  const row = db
    .prepare<[string], DeviceRow>(`SELECT ${DEVICE_SELECT_COLS} FROM devices WHERE id = ?`)
    .get(id);
  if (!row) return null;
  return rowToDevice(row);
}

export function findDeviceByName(db: Db, name: string): DeviceRecord | null {
  const row = db
    .prepare<[string], DeviceRow>(`SELECT ${DEVICE_SELECT_COLS} FROM devices WHERE name = ?`)
    .get(name);
  return row ? rowToDevice(row) : null;
}

/** The client's install identity from its pair-time capabilities, if any. */
export function installIdFrom(caps: DeviceCapability): string | null {
  const raw = caps.installId?.trim();
  return raw ? raw : null;
}

/**
 * The device a client previously paired as, by its per-install identity.
 * Scoped by kind: the identity is minted per app, so the same value can't
 * name two devices of one kind, but nothing stops two kinds from colliding.
 */
export function findDeviceByInstallId(
  db: Db,
  kind: DeviceKind,
  installId: string,
): DeviceRecord | null {
  const row = db
    .prepare<
      [string, string],
      DeviceRow
    >(`SELECT ${DEVICE_SELECT_COLS} FROM devices WHERE kind = ? AND install_id = ?`)
    .get(kind, installId);
  return row ? rowToDevice(row) : null;
}

export type RenameDeviceResult =
  | { ok: true; device: DeviceRecord }
  | { ok: false; reason: "not-found" | "name-taken" };

/**
 * Display rename. Names stay unique per gateway (the by-name adoption path
 * for clients without an install identity matches on them), so a taken name
 * is refused rather than silently suffixed.
 */
export function renameDevice(db: Db, id: DeviceId, name: string): RenameDeviceResult {
  return db.transaction((): RenameDeviceResult => {
    const taken = db
      .prepare<
        [string, string],
        { id: string }
      >("SELECT id FROM devices WHERE name = ? AND id != ?")
      .get(name, id);
    if (taken) return { ok: false, reason: "name-taken" };
    const changed = db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(name, id).changes;
    if (changed === 0) return { ok: false, reason: "not-found" };
    const device = getDevice(db, id);
    return device ? { ok: true, device } : { ok: false, reason: "not-found" };
  })();
}

/**
 * Re-pair flow: repair the existing device identity in place. Re-pair mints
 * fresh tokens, so old tokens are revoked atomically, while device-owned
 * durable state (sources, subscriptions, approvals and audit history) keeps
 * its foreign-key identity.
 *
 * Used when a device pairs back onto the row it is adopted into (by install
 * identity, remembered device id, or name) and that row is offline. Online
 * collisions must be rejected at the call site before we get here. The
 * client's install identity, when it sends one, moves onto this row: any
 * other row of the kind that carried it (a stale remembered device id, a
 * restored backup) releases it.
 */
export function replaceDeviceForRepair(
  db: Db,
  oldId: DeviceId,
  opts: {
    name: string;
    kind: DeviceKind;
    capabilities?: DeviceCapability;
  },
): DeviceRecord {
  if (!isDeviceKind(opts.kind)) {
    throw new Error(`Invalid device kind: ${opts.kind}`);
  }
  if (!opts.name) throw new Error("Device name is required");

  const caps = opts.capabilities ?? {};
  const pairedAt = now();

  const installId = installIdFrom(caps);
  const version = versionFrom(caps);
  const tx = db.transaction((): { installId: string | null; accessLevelId: string | null } => {
    const exists = db
      .prepare<
        [string],
        { install_id: string | null; access_level_id: string | null }
      >("SELECT install_id, access_level_id FROM devices WHERE id = ?")
      .get(oldId);
    if (!exists) throw new Error(`Device not found: ${oldId}`);
    // Existing live sockets authenticated with these credentials may finish
    // their current frame, but cannot reconnect; the caller only selects an
    // offline row for repair.
    db.prepare("DELETE FROM tokens WHERE device_id = ?").run(oldId);
    if (installId) {
      db.prepare(
        "UPDATE devices SET install_id = NULL WHERE kind = ? AND install_id = ? AND id != ?",
      ).run(opts.kind, installId, oldId);
    }
    db.prepare(
      `UPDATE devices
          SET name = ?, kind = ?, capabilities = ?, paired_at = ?, last_seen_at = NULL,
              revoked_at = NULL, install_id = COALESCE(?, install_id),
              apns_device_token = NULL, apns_environment = NULL,
              apns_bundle_id = NULL, apns_token_updated_at = NULL,
              fcm_registration_token = NULL, fcm_token_updated_at = NULL,
              push_transport = NULL, relay_url = NULL, relay_credential = NULL,
              relay_consent_app_id = NULL, relay_consented_at = NULL,
              notification_delivery_health = NULL,
              notification_delivery_health_updated_at = NULL,
              version = ?, version_seen_at = ?, protocol_version = NULL,
              desired_version = NULL, update_state = NULL,
              update_detail = NULL, update_state_at = NULL
        WHERE id = ?`,
    ).run(
      opts.name,
      opts.kind,
      serializeCapabilities(caps),
      pairedAt,
      installId,
      version,
      version ? pairedAt : null,
      oldId,
    );
    // The row keeps its access level: repair restores the same device, so
    // the level the operator put it on still applies to it.
    return { installId: installId ?? exists.install_id, accessLevelId: exists.access_level_id };
  });
  const stored = tx();

  return {
    id: oldId,
    name: opts.name,
    kind: opts.kind,
    capabilities: storedCapabilities(caps),
    version,
    versionSeenAt: version ? pairedAt : null,
    accessLevelId: stored.accessLevelId,
    protocolVersion: null,
    pairedAt,
    lastSeenAt: null,
    revokedAt: null,
    installId: stored.installId,
    selfEmails: [],
    selfPhones: [],
    apnsRegistration: null,
    fcmRegistration: null,
    pushTransport: null,
    relayUrl: null,
    relayCredential: null,
    relayConsent: null,
    notificationDeliveryHealth: null,
    notificationDeliveryHealthUpdatedAt: null,
    desiredVersion: null,
    updateState: null,
    updateDetail: null,
    updateStateAt: null,
  };
}

export function listDevices(db: Db): DeviceRecord[] {
  return db
    .prepare<[], DeviceRow>(`SELECT ${DEVICE_SELECT_COLS} FROM devices ORDER BY paired_at ASC`)
    .all()
    .map(rowToDevice);
}

/**
 * Hard-delete a device row. Its re-auth reminder episodes go with it —
 * nothing references `reauth_reminders` by foreign key, so the rows would
 * otherwise outlive the device.
 */
export function deleteDevice(db: Db, id: DeviceId): boolean {
  return db.transaction(() => {
    db.prepare("DELETE FROM reauth_reminders WHERE device_id = ?").run(id);
    return db.prepare("DELETE FROM devices WHERE id = ?").run(id).changes > 0;
  })();
}

/** True for an `unsupported` result reported by a different release or source checkout. */
const UNSUPPORTED_BUILD_CHANGED =
  "update_state = 'unsupported' AND (version IS NOT ? OR json_extract(capabilities, '$.sourceCommit') IS NOT ?)";

/**
 * Persist what a completed hello taught the gateway about a device: the
 * capabilities it declares, the product version it reports, and the wire
 * protocol the handshake settled on.
 *
 * A hello replaces the capability bag wholesale — that is the contract, and
 * it is what lets a client stop hosting a source type by simply omitting it.
 * The version column follows the same rule: a client that reports no version
 * clears the reading rather than leaving a stale one standing, because a
 * downgrade to a build that predates the ledger is exactly the case where a
 * remembered version would be a lie. `version_seen_at` is the moment the
 * gateway last recorded a version, so an operator can tell a fresh reading
 * from one taken months ago.
 *
 * `protocolVersion` is the gateway's own observation from the hello envelope,
 * never a client-declared capability: a device stranded on a protocol this
 * gateway no longer speaks cannot connect to correct it, and this column is
 * what lets the ledger say so instead of reporting silence.
 */
export function updateDeviceCapabilities(
  db: Db,
  id: DeviceId,
  capabilities: DeviceCapability,
  protocolVersion?: number,
): SourceId[] {
  return db.transaction(() => {
    const version = versionFrom(capabilities);
    const sourceCommit = capabilities.sourceCommit ?? null;
    const at = now();
    // An `unsupported` update result describes the build that gave it. A device
    // reporting any other release or exact source commit is a different build,
    // which may implement the command, so the record is cleared in the same
    // statement that writes the build identity. The
    // CASE expressions read the row's values before this UPDATE assigns them.
    db.prepare(
      `UPDATE devices
        SET capabilities = ?, last_seen_at = ?, version = ?, version_seen_at = ?,
            protocol_version = COALESCE(?, protocol_version),
            desired_version = CASE WHEN ${UNSUPPORTED_BUILD_CHANGED} THEN NULL ELSE desired_version END,
            update_detail = CASE WHEN ${UNSUPPORTED_BUILD_CHANGED} THEN NULL ELSE update_detail END,
            update_state_at = CASE WHEN ${UNSUPPORTED_BUILD_CHANGED} THEN NULL ELSE update_state_at END,
            update_state = CASE WHEN ${UNSUPPORTED_BUILD_CHANGED} THEN NULL ELSE update_state END
      WHERE id = ?`,
    ).run(
      serializeCapabilities(capabilities),
      at,
      version,
      version ? at : null,
      protocolVersion ?? null,
      version,
      sourceCommit,
      version,
      sourceCommit,
      version,
      sourceCommit,
      version,
      sourceCommit,
      id,
    );
    return extendUnanimousMemberConfigContracts(db, id);
  })();
}

/**
 * Record what an operator asked of one device, and how far that request has
 * got. One statement for the whole lifecycle so the four columns can never
 * drift apart: a state without the version it belongs to would be unreadable.
 *
 * Passing `desiredVersion: null` closes the request out once the device has
 * reached the version, keeping `state` and `detail` as the record of how it ended.
 *
 * The two state guards make the write a compare-and-set, which the delivery
 * path needs in both directions. `notIfState` is how a request is claimed:
 * two operators pressing the same button, or two of one device's sockets
 * settling at once, must not both send a command. `onlyIfState` is how a
 * claimed request is closed out: a device that finishes fast reports its
 * outcome while the delivery is still in flight, and that outcome must not be
 * replaced by the older news about the delivery. `onlyIfReportedVersion`
 * fences a settlement based on a hello against another socket reporting a
 * different running build before the settlement reaches the writer. Returns
 * whether the row was written — a false is the caller learning it did not win
 * the claim, and a revoked row is never written at all.
 */
export function setDeviceUpdateRequest(
  db: Db,
  id: DeviceId,
  request: {
    desiredVersion: string | null;
    state: DeviceUpdateState;
    detail?: string | null;
    /** Write only while the row still reads this state. */
    onlyIfState?: DeviceUpdateState;
    /** Fence a result or reconnect against a replacement update request. */
    onlyIfDesiredVersion?: string | null;
    /** Fence a settlement against a different capability report. */
    onlyIfReportedVersion?: string | null;
    /** Fence an exact-commit settlement against a different source build. */
    onlyIfSourceCommit?: string | null;
    /** Write only while the row does NOT read this state. */
    notIfState?: DeviceUpdateState;
  },
): boolean {
  const params: Array<string | number | null> = [
    request.desiredVersion,
    request.state,
    request.detail ?? null,
    now(),
    id,
  ];
  let guard = "";
  if (request.onlyIfState) {
    guard += " AND update_state = ?";
    params.push(request.onlyIfState);
  }
  if ("onlyIfDesiredVersion" in request) {
    guard += " AND desired_version IS ?";
    params.push(request.onlyIfDesiredVersion ?? null);
  }
  if ("onlyIfReportedVersion" in request) {
    guard += " AND version IS ?";
    params.push(request.onlyIfReportedVersion ?? null);
  }
  if ("onlyIfSourceCommit" in request) {
    guard += " AND json_extract(capabilities, '$.sourceCommit') IS ?";
    params.push(request.onlyIfSourceCommit ?? null);
  }
  if (request.notIfState) {
    // `IS NOT` rather than `<>`: a NULL update_state means nothing was ever
    // asked of this device, and SQL's three-valued `<>` would exclude it.
    guard += " AND update_state IS NOT ?";
    params.push(request.notIfState);
  }
  // Never on a revoked row. A request read before a revoke and written after
  // it would otherwise leave a version owed to a device nothing runs on,
  // outliving the clear the revoke performed.
  return (
    db
      .prepare(
        `UPDATE devices
            SET desired_version = ?, update_state = ?, update_detail = ?, update_state_at = ?
          WHERE id = ? AND revoked_at IS NULL${guard}`,
      )
      .run(...params).changes > 0
  );
}

/**
 * Hostable source types the device has advertised via its WS `hello`
 * handshake, or `null` when the device hasn't declared capabilities yet
 * (caller-side convention: treat `null` as "permit").
 */
export function getDeviceHostableSourceTypes(db: Db, id: DeviceId): string[] | null {
  const dev = getDevice(db, id);
  if (!dev) return null;
  const types = dev.capabilities.hostableSourceTypes;
  return Array.isArray(types) ? (types as string[]) : null;
}

export function touchDevice(db: Db, id: DeviceId): void {
  // `last_seen_at` is an informational activity beacon — when the backfill
  // worker is holding a write transaction this UPDATE can race into
  // SQLITE_BUSY. Swallow it so a transient worker-write contention can't
  // crash the gateway (this runs on every WS message from every device).
  try {
    db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now(), id);
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code !== "SQLITE_BUSY") throw err;
  }
}

function rowToDevice(row: DeviceRow): DeviceRecord {
  return {
    id: DeviceId(row.id),
    name: row.name,
    kind: isDeviceKind(row.kind) ? row.kind : ("cli" as DeviceKind),
    capabilities: parseCapabilities(row.capabilities, row.id),
    version: row.version,
    versionSeenAt: row.version_seen_at,
    protocolVersion: row.protocol_version,
    pairedAt: row.paired_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    installId: row.install_id,
    selfEmails: parseStringArray(row.self_emails),
    selfPhones: parseStringArray(row.self_phones),
    accessLevelId: row.access_level_id,
    apnsRegistration: parseApnsRegistration(row),
    fcmRegistration: parseFcmRegistration(row),
    pushTransport: parsePushTransport(row.push_transport),
    relayUrl: row.relay_url,
    relayCredential: row.relay_credential,
    relayConsent:
      row.relay_consent_app_id !== null && row.relay_consented_at !== null
        ? { appId: row.relay_consent_app_id, grantedAt: row.relay_consented_at }
        : null,
    notificationDeliveryHealth: parseNotificationDeliveryHealth(row.notification_delivery_health),
    notificationDeliveryHealthUpdatedAt: row.notification_delivery_health_updated_at,
    desiredVersion: row.desired_version,
    updateState:
      row.update_state && isDeviceUpdateState(row.update_state) ? row.update_state : null,
    updateDetail: row.update_detail,
    updateStateAt: row.update_state_at,
  };
}

function parseNotificationDeliveryHealth(value: string | null): NotificationDeliveryHealth | null {
  if (value === null) return null;
  switch (value) {
    case "healthy":
    case "not-determined":
    case "permission-denied":
    case "scheduled-summary":
    case "alerts-disabled":
      return value;
    default:
      return null;
  }
}

function parsePushTransport(value: string | null): PushTransport | null {
  return value !== null && isPushTransport(value) ? value : null;
}

function parseFcmRegistration(row: DeviceRow): FcmRegistration | null {
  if (!row.fcm_registration_token || row.fcm_token_updated_at == null) return null;
  return {
    registrationToken: row.fcm_registration_token,
    updatedAt: row.fcm_token_updated_at,
  };
}

function parseApnsRegistration(row: DeviceRow): ApnsRegistration | null {
  if (
    !row.apns_device_token ||
    !row.apns_environment ||
    !row.apns_bundle_id ||
    row.apns_token_updated_at == null
  ) {
    return null;
  }
  const env = row.apns_environment;
  if (env !== "sandbox" && env !== "production") return null;
  return {
    deviceToken: row.apns_device_token,
    environment: env,
    bundleId: row.apns_bundle_id,
    updatedAt: row.apns_token_updated_at,
  };
}

/**
 * Replace the device's self annotation. Pass `null` for either field to
 * leave it untouched. The caller is responsible for upstream validation
 * (E.164 phones, normalized emails) — this is a raw setter.
 *
 * #282 — used by `omnesis devices set-self` to seed the canonical self
 * person before any contacts source has synced.
 */
export function updateDeviceSelfInfo(
  db: Db,
  id: DeviceId,
  patch: { selfEmails?: string[] | null; selfPhones?: string[] | null },
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.selfEmails !== undefined && patch.selfEmails !== null) {
    sets.push("self_emails = ?");
    params.push(JSON.stringify(patch.selfEmails));
  }
  if (patch.selfPhones !== undefined && patch.selfPhones !== null) {
    sets.push("self_phones = ?");
    params.push(JSON.stringify(patch.selfPhones));
  }
  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE devices SET ${sets.join(", ")} WHERE id = ?`).run(
    ...(params as [string | number, ...(string | number)[]]),
  );
}

/** Persist the phone's normalized OS notification state with gateway receipt time. */
export function setNotificationDeliveryHealth(
  db: Db,
  id: DeviceId,
  status: NotificationDeliveryHealth,
  updatedAt: number,
): void {
  const result = db
    .prepare(
      `UPDATE devices
          SET notification_delivery_health = ?,
              notification_delivery_health_updated_at = ?
        WHERE id = ?`,
    )
    .run(status, updatedAt, id);
  if (result.changes === 0)
    throw new Error(`setNotificationDeliveryHealth: device ${id} not found`);
}

// ── APNs registration (iOS push) ───────────────────────────────────────────

/**
 * Record the APNs device token for an iOS device. Called by the
 * unified push-registration service. The previous registration is replaced
 * wholesale; environment can flip when the user switches between a Debug
 * build (sandbox) and a TestFlight / App Store build (production).
 *
 * The hex-token / bundle-id / environment fields are validated at the
 * HTTP boundary — this writer trusts its callers.
 */
export function setApnsToken(db: Db, id: DeviceId, registration: ApnsRegistration): void {
  const result = db
    .prepare(
      `UPDATE devices
         SET apns_device_token = ?,
             apns_environment = ?,
             apns_bundle_id = ?,
             apns_token_updated_at = ?,
             fcm_registration_token = NULL,
             fcm_token_updated_at = NULL,
             push_transport = ?,
             relay_url = NULL,
             relay_credential = NULL
       WHERE id = ?`,
    )
    .run(
      registration.deviceToken,
      registration.environment,
      registration.bundleId,
      registration.updatedAt,
      "direct-apns",
      id,
    );
  if (result.changes === 0) {
    throw new Error(`setApnsToken: device ${id} not found`);
  }
}

/**
 * Null out the APNs registration for a device. Called when APNs
 * responds with `Unregistered` / `BadDeviceToken` (the user
 * uninstalled the app, or the token has been invalidated) so the next
 * `notify-ios` fan-out skips this device cleanly. The iOS app will
 * re-register on its next launch.
 */
export function clearApnsToken(db: Db, id: DeviceId, expected?: ApnsRegistration): boolean {
  const result = db
    .prepare(
      `UPDATE devices
       SET apns_device_token = NULL,
           apns_environment = NULL,
           apns_bundle_id = NULL,
           apns_token_updated_at = NULL,
           push_transport = CASE WHEN push_transport = 'direct-apns' THEN NULL ELSE push_transport END
     WHERE id = ?
       AND (? IS NULL OR (
         apns_device_token = ? AND apns_environment = ? AND apns_bundle_id = ?
         AND apns_token_updated_at = ?
       ))`,
    )
    .run(
      id,
      expected?.deviceToken ?? null,
      expected?.deviceToken ?? null,
      expected?.environment ?? null,
      expected?.bundleId ?? null,
      expected?.updatedAt ?? null,
    );
  return result.changes === 1;
}

/**
 * Every iOS device that currently has a complete APNs registration.
 * The notify-ios dispatcher fans out to this list. Non-iOS kinds and
 * iOS devices with a null registration are excluded — there's nothing
 * to send to.
 */
export function listIosDevicesWithApnsToken(db: Db): DeviceRecord[] {
  return db
    .prepare<[], DeviceRow>(
      `SELECT ${DEVICE_SELECT_COLS}
         FROM devices
        WHERE kind = 'ios'
          AND apns_device_token IS NOT NULL
          AND apns_environment IS NOT NULL
          AND apns_bundle_id IS NOT NULL
          AND apns_token_updated_at IS NOT NULL
        ORDER BY paired_at ASC`,
    )
    .all()
    .map(rowToDevice);
}

// ── FCM registration (Android push) ────────────────────────────────────────

export function setFcmToken(db: Db, id: DeviceId, registration: FcmRegistration): void {
  const result = db
    .prepare(
      `UPDATE devices
          SET fcm_registration_token = ?,
              fcm_token_updated_at = ?,
              apns_device_token = NULL,
              apns_environment = NULL,
              apns_bundle_id = NULL,
              apns_token_updated_at = NULL,
              push_transport = ?,
              relay_url = NULL,
              relay_credential = NULL
        WHERE id = ?`,
    )
    .run(registration.registrationToken, registration.updatedAt, "direct-fcm", id);
  if (result.changes === 0) throw new Error(`setFcmToken: device ${id} not found`);
}

export function clearFcmToken(db: Db, id: DeviceId, expected?: FcmRegistration): boolean {
  const result = db
    .prepare(
      `UPDATE devices
        SET fcm_registration_token = NULL,
            fcm_token_updated_at = NULL,
            push_transport = CASE WHEN push_transport = 'direct-fcm' THEN NULL ELSE push_transport END
      WHERE id = ?
        AND (? IS NULL OR (
          fcm_registration_token = ? AND fcm_token_updated_at = ?
        ))`,
    )
    .run(
      id,
      expected?.registrationToken ?? null,
      expected?.registrationToken ?? null,
      expected?.updatedAt ?? null,
    );
  return result.changes === 1;
}

/**
 * Authoritative outcome of recording one phone's relay authorization. The
 * conflict decision lives inside the transaction, never on a reader-side
 * snapshot: a hello landing between the service's read and this write must
 * not flip an adoption into a silent cross-app grant, nor a grant into a
 * dead consent row the phone then has to withdraw.
 */
export type RelayPushConsentOutcome = "granted" | "identity-mismatch" | "device-not-found";

/**
 * Record one phone's authorization for the published app named in its
 * disclosure. The caller attested platform and app identity over its own
 * device channel, so when the row predates the pushAppId capability the write
 * adopts the attested identity instead of refusing: a phone that paired
 * before the capability existed would otherwise need a re-pair for a race it
 * did not cause. A declared identity that conflicts is refused here, never
 * adopted.
 */
export function setRelayPushConsent(
  db: Db,
  id: DeviceId,
  consent: { appId: string; grantedAt: number },
): RelayPushConsentOutcome {
  return db.transaction((): RelayPushConsentOutcome => {
    const row = db.prepare(`SELECT capabilities FROM devices WHERE id = ?`).get(id) as
      | { capabilities: string | null }
      | undefined;
    if (!row) return "device-not-found";
    const caps = parseCapabilities(row.capabilities, id);
    if (caps.pushAppId !== undefined && caps.pushAppId !== consent.appId) {
      return "identity-mismatch";
    }
    if (caps.pushAppId === undefined) {
      const adopted = { ...caps, pushAppId: consent.appId };
      return db
        .prepare(
          `UPDATE devices
                SET relay_consent_app_id = ?,
                    relay_consented_at = ?,
                    capabilities = ?,
                    push_transport = CASE WHEN push_transport = 'relay' THEN NULL ELSE push_transport END,
                    relay_url = NULL,
                    relay_credential = NULL
              WHERE id = ?
                AND revoked_at IS NULL
                AND kind IN ('ios', 'android')`,
        )
        .run(consent.appId, consent.grantedAt, serializeCapabilities(adopted), id).changes === 1
        ? "granted"
        : "device-not-found";
    }
    return db
      .prepare(
        `UPDATE devices
              SET relay_consent_app_id = ?,
                  relay_consented_at = ?,
                  push_transport = CASE WHEN push_transport = 'relay' THEN NULL ELSE push_transport END,
                  relay_url = NULL,
                  relay_credential = NULL
            WHERE id = ?
              AND revoked_at IS NULL
              AND kind IN ('ios', 'android')`,
      )
      .run(consent.appId, consent.grantedAt, id).changes === 1
      ? "granted"
      : "device-not-found";
  })();
}

/** Withdraw relay authorization and its credential in one serialized write. */
export function withdrawRelayPushConsent(db: Db, id: DeviceId): boolean {
  return (
    db
      .prepare(
        `UPDATE devices
            SET relay_consent_app_id = NULL,
                relay_consented_at = NULL,
                push_transport = CASE WHEN push_transport = 'relay' THEN NULL ELSE push_transport END,
                relay_url = NULL,
                relay_credential = NULL
          WHERE id = ?`,
      )
      .run(id).changes === 1
  );
}

/** Store the opaque credential earned by a published app from its relay. */
export function setRelayPushRegistration(
  db: Db,
  id: DeviceId,
  registration: { relayUrl: string; credential: string; appId: string },
): boolean {
  const result = db
    .prepare(
      `UPDATE devices
          SET push_transport = 'relay',
              relay_url = ?,
              relay_credential = ?,
              apns_device_token = NULL,
              apns_environment = NULL,
              apns_bundle_id = NULL,
              apns_token_updated_at = NULL,
              fcm_registration_token = NULL,
              fcm_token_updated_at = NULL
        WHERE id = ?
          AND revoked_at IS NULL
          AND relay_consent_app_id = ?
          AND relay_consented_at IS NOT NULL`,
    )
    .run(registration.relayUrl, registration.credential, id, registration.appId);
  return result.changes === 1;
}

export function listAndroidDevicesWithFcmToken(db: Db): DeviceRecord[] {
  return db
    .prepare<[], DeviceRow>(
      `SELECT ${DEVICE_SELECT_COLS}
         FROM devices
        WHERE kind = 'android'
          AND fcm_registration_token IS NOT NULL
          AND fcm_token_updated_at IS NOT NULL
        ORDER BY paired_at ASC`,
    )
    .all()
    .map(rowToDevice);
}

// ── Pairing flow ────────────────────────────────────────────────────────────
//
// Admin creates a pending pairing record with a short random code. The target
// device (CLI, iOS, etc.) exchanges the code for a fresh device row + token.
// Pairing codes expire after DEFAULT_PAIRING_TTL_MS.

const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;

export interface PendingPairing {
  pairingCode: string;
  name: string;
  kind: DeviceKind;
  scopes: Scope[];
  expiresAt: number;
  createdAt: number;
  /**
   * Self annotation (#284) staged with the pairing code. Normalized
   * email / E.164 phone identifiers belonging to the device's owner,
   * applied to the new device row at redeem time so the canonical self
   * person can bootstrap before any contacts source has synced. Empty
   * arrays when the operator skipped the annotation.
   */
  selfEmails: string[];
  selfPhones: string[];
  /** Exact existing device selected by the admin for a repair ceremony. */
  repairDeviceId: DeviceId | null;
  /** The access level the paired integration is put on, chosen in the portal. */
  accessLevelId: string | null;
  /**
   * SHA-256 fingerprint (hex, lowercase, no colons) of the gateway's TLS
   * cert. Populated when the caller provides `tlsFingerprintSha256` to
   * {@link createPairing}; empty string otherwise (test harnesses without
   * TLS wiring). The CLI bakes this into the V3 QR payload so iOS can
   * pin the cert on first connect (TOFU).
   */
  tlsFingerprint: string;
}

export type CreatePairingOptions = Parameters<typeof createPairing>[1];

export function createPairing(
  db: Db,
  opts: {
    /**
     * Optional admin-supplied device name. Empty / undefined means "let the
     * redeeming device pick" — see resolveDeviceName().
     */
    name?: string;
    kind: DeviceKind;
    scopes: readonly Scope[];
    ttlMs?: number;
    /**
     * Self annotation (#284) to stage with this pairing code. Already
     * validated + normalized by the caller (the HTTP boundary): emails
     * lowercased via `normalizeEmail`, phones in E.164 via `normalizePhone`.
     * Applied to the device row at redeem. Omit / empty to skip.
     */
    selfEmails?: readonly string[];
    selfPhones?: readonly string[];
    /** Existing device selected by the admin for an explicit repair. */
    repairDeviceId?: DeviceId;
    /** Access level to put the paired integration on; see `PendingPairing`. */
    accessLevelId?: string;
    /**
     * Gateway's TLS cert SHA-256 fingerprint, echoed back to the caller so
     * it can be folded into the V3 QR pairing payload. Optional only because
     * unit tests don't always wire TLS — production always supplies it.
     */
    tlsFingerprintSha256?: string;
  },
): PendingPairing {
  if (!isDeviceKind(opts.kind)) {
    throw new Error(`Invalid device kind: ${opts.kind}`);
  }
  for (const s of opts.scopes) {
    if (!isValidScope(s)) throw new Error(`Invalid scope: ${s}`);
  }

  // Short human-friendly code: 10 hex chars (5 bytes). Not a secret in itself —
  // it grants an admin-chosen scope set, so treat it like a magic link.
  const pairingCode = randomBytes(5).toString("hex").toUpperCase();
  const createdAt = now();
  const expiresAt = createdAt + (opts.ttlMs ?? DEFAULT_PAIRING_TTL_MS);
  // device_pairings.name is NOT NULL — empty string sentinel encodes
  // "no admin name". resolveDeviceName() unpacks it at redeem time.
  const storedName = (opts.name ?? "").trim();
  const selfEmails = [...(opts.selfEmails ?? [])];
  const selfPhones = [...(opts.selfPhones ?? [])];

  db.prepare(
    `INSERT INTO device_pairings
       (pairing_code, name, kind, scopes, created_at, expires_at, self_emails, self_phones,
        repair_device_id, access_level_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pairingCode,
    storedName,
    opts.kind,
    devicePairingsScopesCodec.serialize([...opts.scopes]),
    createdAt,
    expiresAt,
    JSON.stringify(selfEmails),
    JSON.stringify(selfPhones),
    opts.repairDeviceId ?? null,
    opts.accessLevelId ?? null,
  );

  return {
    pairingCode,
    name: storedName,
    kind: opts.kind,
    scopes: [...opts.scopes],
    createdAt,
    expiresAt,
    selfEmails,
    selfPhones,
    repairDeviceId: opts.repairDeviceId ?? null,
    accessLevelId: opts.accessLevelId ?? null,
    tlsFingerprint: opts.tlsFingerprintSha256 ?? "",
  };
}

export function consumePairing(
  db: Db,
  pairingCode: string,
  expectedKind?: DeviceKind,
): PendingPairing | null {
  const pending = peekPairing(db, pairingCode);
  if (!pending) return null;

  // Kind-scoped consumption: when the caller expects a specific device kind
  // (e.g. portal login expects `portal`), a code minted for a different kind
  // is left untouched and reported as a miss — so a portal login attempt
  // can't burn a device's pairing code (and vice-versa). better-sqlite3 is
  // synchronous and the writer is single-threaded, so the check-then-delete
  // below is effectively atomic (no other writer interleaves).
  if (expectedKind !== undefined && pending.kind !== expectedKind) return null;

  // Delete regardless of expiry — one-shot consumption.
  db.prepare("DELETE FROM device_pairings WHERE pairing_code = ?").run(pairingCode);

  return pending.expiresAt < now() ? null : pending;
}

export type DevicePairingRedemption =
  | { outcome: "invalid" }
  | { outcome: "conflict"; error: string }
  | {
      outcome: "paired";
      device: DeviceRecord;
      replacedDeviceId?: DeviceId;
      tokenId: ReturnType<typeof createToken>["id"];
      token: string;
      scopes: Scope[];
      /** True when this response was replayed from a receipt rather than minted now. */
      replayed: boolean;
    };

type PairedDeviceRedemption = Extract<DevicePairingRedemption, { outcome: "paired" }>;

export type CreateOrAdoptDeviceResult =
  | {
      outcome: "created" | "adopted";
      device: DeviceRecord;
      tokenId: ReturnType<typeof createToken>["id"];
      token: string;
    }
  /** A live row of that name blocks it; `kind` is the row's, for the message. */
  | { outcome: "name-taken"; kind: DeviceKind }
  /** The row of that name is revoked but still holding a socket. */
  | { outcome: "online" };

/**
 * Register a device directly (no pairing code) and mint its first credential
 * as one writer transaction.
 *
 * A revoked row of the same name AND kind is adopted in place rather than
 * refused: the local collector re-registers under a fixed
 * `<hostname>-collector` name, and its sources, memberships and cursors all
 * hang off the device id, so a fresh row would strand them. Any other row of
 * that name is a refusal.
 *
 * The name lookup, the adoption decision and the write share one transaction
 * because the writer is a single thread: outside it, a concurrent repair
 * redemption could un-revoke the row between the read and the write, and two
 * concurrent registrations of one new name would race the `devices.name`
 * unique index instead of getting a clean refusal.
 */
export function createOrAdoptDevice(
  db: Db,
  input: {
    name: string;
    kind: DeviceKind;
    capabilities: DeviceCapability;
    scopes: readonly Scope[];
    /** Devices holding a live socket right now, snapshotted by the caller. */
    onlineDeviceIds?: readonly DeviceId[];
  },
): CreateOrAdoptDeviceResult {
  return db
    .transaction((): CreateOrAdoptDeviceResult => {
      const taken = findDeviceByName(db, input.name);
      const adoptable =
        taken && taken.revokedAt !== null && taken.kind === input.kind ? taken : null;
      if (taken && !adoptable) return { outcome: "name-taken", kind: taken.kind };
      if (adoptable && input.onlineDeviceIds?.includes(adoptable.id)) {
        return { outcome: "online" };
      }
      const written = adoptable
        ? replaceDeviceForRepair(db, adoptable.id, {
            name: input.name,
            kind: input.kind,
            capabilities: input.capabilities,
          })
        : createDevice(db, {
            name: input.name,
            kind: input.kind,
            capabilities: input.capabilities,
          });
      const credential = createToken(db, written.id, input.scopes, "initial");
      return {
        outcome: adoptable ? "adopted" : "created",
        // Re-read: an adopted row keeps columns the repair UPDATE does not
        // touch, such as its self-identity annotation.
        device: getDevice(db, written.id) ?? written,
        tokenId: credential.id,
        token: credential.token,
      };
    })
    .immediate();
}

/**
 * Refusal of a redemption the operator is expected to retry. Thrown rather
 * than returned so the transaction rolls back: the redemption already
 * consumed the one-shot pairing code, and a conflict the operator can clear
 * (disconnect the device, pick another name) must leave that code usable.
 */
class DevicePairingConflict extends Error {}

/**
 * Redeem a non-agent pairing as one writer transaction. The pairing code,
 * durable device adoption, old-token invalidation, staged self identity, and
 * new credential generation either all commit or all roll back. Resolving the
 * adoption candidate here also makes concurrent redeems for one install
 * serialize: the later generation invalidates the earlier one.
 */
export function redeemDevicePairing(
  db: Db,
  input: {
    pairingCode: string;
    /** The kind the code was minted for; unknown when a replay is being attempted. */
    expectedKind?: DeviceKind;
    capabilities: DeviceCapability;
    onlineDeviceIds?: readonly DeviceId[];
    /**
     * High-entropy client key that makes the one-use redemption safe to
     * retry: a repeat with the same code, key and capabilities returns the
     * credentials the first attempt minted instead of "invalid or expired".
     */
    idempotencyKey?: string;
  },
): DevicePairingRedemption {
  try {
    return db
      .transaction((): DevicePairingRedemption => {
        const requestFingerprint = devicePairingRequestFingerprint(input.capabilities);
        if (input.idempotencyKey) {
          const receipt = readPairingReceipt<PairedDeviceRedemption>(
            db,
            input.pairingCode,
            input.idempotencyKey,
            requestFingerprint,
          );
          if (receipt?.kind === "replay") return { ...receipt.result, replayed: true };
          if (receipt) {
            return receipt.kind === "invalid"
              ? { outcome: "invalid" }
              : { outcome: "conflict", error: receipt.error };
          }
        }
        // A caller that could not name the code's kind is attempting a replay
        // (the reader-side peek saw no pending row). With no receipt to answer
        // from, this must never consume a code it never previewed.
        if (!input.expectedKind) return { outcome: "invalid" };
        const pending = consumePairing(db, input.pairingCode, input.expectedKind);
        if (!pending) return { outcome: "invalid" };

        // A repair code names its device up front. That target is the only
        // row the redemption may adopt: without this pin, a code minted for
        // one device could be redeemed by a client whose install identity or
        // suggested name resolves to a different row, silently taking over a
        // device the operator never selected.
        const repairTarget = pending.repairDeviceId ? getDevice(db, pending.repairDeviceId) : null;
        if (pending.repairDeviceId && !repairTarget) {
          // `device_pairings.repair_device_id` cascades, so forgetting the
          // device normally takes the code with it and this reads as an
          // invalid code. This arm covers a row that outlived its device.
          throw new DevicePairingConflict("The selected repair device no longer exists.");
        }
        if (repairTarget && repairTarget.kind !== pending.kind) {
          throw new DevicePairingConflict(
            `The selected repair device is a ${repairTarget.kind} device, not a ${pending.kind} device.`,
          );
        }

        const suggested =
          repairTarget?.name ?? resolveDeviceName(pending.name, pending.kind, input.capabilities);
        const installId = installIdFrom(input.capabilities);
        const previousId = tryDeviceId(input.capabilities.previousDeviceId ?? "");
        const byInstall = installId ? findDeviceByInstallId(db, pending.kind, installId) : null;
        const byPrevious = previousId ? getDevice(db, previousId) : null;
        const byName = findDeviceByName(db, suggested);
        const nameCandidate =
          byName?.kind === pending.kind &&
          (byName.installId === null || byName.installId === installId)
            ? byName
            : null;
        // A repair touches its named device and nothing else. When the
        // redeemer's install identity belongs to a different row, adopting
        // anyway would move that identity onto the repaired device and leave
        // the other one to be adopted by name later — so refuse instead.
        if (repairTarget && byInstall && byInstall.id !== repairTarget.id) {
          throw new DevicePairingConflict(
            `This client is already paired as "${byInstall.name}". Repair that device, or pair this one fresh.`,
          );
        }

        const candidate =
          repairTarget ??
          byInstall ??
          (byPrevious?.kind === pending.kind ? byPrevious : null) ??
          nameCandidate;

        if (!candidate && byName && byName.kind !== pending.kind) {
          throw new DevicePairingConflict(
            `Device name "${suggested}" is reserved by a ${byName.kind} device. Pick a different name or revoke the existing device first.`,
          );
        }
        if (candidate && input.onlineDeviceIds?.includes(candidate.id)) {
          throw new DevicePairingConflict(
            `This ${candidate.kind} device ("${candidate.name}") is currently online. Disconnect or revoke it before pairing it again.`,
          );
        }

        if (!scopesAllowedForDeviceKind(pending.kind, pending.scopes)) {
          throw new DevicePairingConflict(new DeviceKindScopeError().message);
        }
        const replacedDeviceId = candidate?.id;
        const device = candidate
          ? replaceDeviceForRepair(db, candidate.id, {
              name: candidate.name,
              kind: pending.kind,
              capabilities: input.capabilities,
            })
          : createDevice(db, {
              name: byName ? `${suggested}-${randomBytes(2).toString("hex")}` : suggested,
              kind: pending.kind,
              capabilities: input.capabilities,
            });
        if (pending.selfEmails.length > 0 || pending.selfPhones.length > 0) {
          updateDeviceSelfInfo(db, device.id, {
            ...(pending.selfEmails.length > 0 ? { selfEmails: pending.selfEmails } : {}),
            ...(pending.selfPhones.length > 0 ? { selfPhones: pending.selfPhones } : {}),
          });
        }
        if (pending.kind === "integration" && pending.accessLevelId) {
          putPairedIntegrationOnLevel(db, device.id, pending.accessLevelId, now());
        }
        const credential = createToken(db, device.id, pending.scopes, "paired");
        const result: PairedDeviceRedemption = {
          outcome: "paired",
          device: getDevice(db, device.id) ?? device,
          ...(replacedDeviceId ? { replacedDeviceId } : {}),
          tokenId: credential.id,
          token: credential.token,
          scopes: pending.scopes,
          replayed: false,
        };
        if (input.idempotencyKey) {
          writePairingReceipt(
            db,
            input.pairingCode,
            input.idempotencyKey,
            requestFingerprint,
            result,
          );
        }
        return result;
      })
      .immediate();
  } catch (error) {
    if (error instanceof DevicePairingConflict) {
      return { outcome: "conflict", error: error.message };
    }
    throw error;
  }
}

/** Invalidate one unused pairing code. Returns false after redemption or expiry cleanup. */
export function revokePairing(db: Db, pairingCode: string): boolean {
  return (
    db.prepare("DELETE FROM device_pairings WHERE pairing_code = ?").run(pairingCode).changes > 0
  );
}

/**
 * Inspect a pairing without consuming it. Pairing redemption uses this only
 * to validate the complete request before entering the atomic redemption
 * transaction, which owns install-id adoption and name-collision resolution.
 */
export function peekPairing(db: Db, pairingCode: string): PendingPairing | null {
  const row = db
    .prepare<
      [string],
      {
        pairing_code: string;
        name: string;
        kind: string;
        scopes: string;
        created_at: number;
        expires_at: number;
        self_emails: string;
        self_phones: string;
        repair_device_id: string | null;
        access_level_id: string | null;
      }
    >(
      "SELECT pairing_code, name, kind, scopes, created_at, expires_at, self_emails, self_phones, repair_device_id, access_level_id FROM device_pairings WHERE pairing_code = ?",
    )
    .get(pairingCode);

  if (!row) return null;

  return {
    pairingCode: row.pairing_code,
    name: row.name,
    kind: isDeviceKind(row.kind) ? row.kind : ("cli" as DeviceKind),
    scopes: devicePairingsScopesCodec.parseWithFallback(row.scopes, { rowId: row.pairing_code }),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    selfEmails: parseStringArray(row.self_emails),
    selfPhones: parseStringArray(row.self_phones),
    repairDeviceId: row.repair_device_id ? DeviceId(row.repair_device_id) : null,
    accessLevelId: row.access_level_id,
    // Not persisted — the fingerprint only matters at issue time (echoed in
    // the /admin/devices/pair response so the CLI can stamp it into the QR).
    tlsFingerprint: "",
  };
}

export interface AgentIntegrationPairingCredentials {
  delivery: ReturnType<typeof createToken> & { scopes: Scope[] };
  ingestion: ReturnType<typeof createToken> & { scopes: Scope[] };
  management: ReturnType<typeof createToken> & { scopes: Scope[] };
}

export type AgentIntegrationPairingResult =
  | {
      outcome: "paired";
      pending: PendingPairing;
      device: DeviceRecord;
      credentials: AgentIntegrationPairingCredentials;
      replayed: boolean;
    }
  | { outcome: "invalid"; error: string }
  | { outcome: "conflict"; error: string };

/**
 * Redeem an agent pairing, create/repair its device, apply staged identity,
 * and mint all three split credentials as one transaction. Any validation or
 * token failure rolls the code and device state back together.
 */
export function redeemAgentIntegrationPairing(
  db: Db,
  input: {
    pairingCode: string;
    harness: "openclaw" | "hermes";
    capabilities: DeviceCapability;
    /** High-entropy client key that makes a one-use redemption crash-recoverable. */
    idempotencyKey?: string;
    /** Preflight-confirmed offline device eligible for in-place repair. */
    repairDeviceId?: DeviceId;
  },
): AgentIntegrationPairingResult {
  try {
    return db.transaction(() => {
      const requestFingerprint = agentPairingRequestFingerprint(input);
      if (input.idempotencyKey) {
        const receipt = readPairingReceipt<PairedAgentIntegration>(
          db,
          input.pairingCode,
          input.idempotencyKey,
          requestFingerprint,
        );
        if (receipt?.kind === "replay") return { ...receipt.result, replayed: true };
        if (receipt) return { outcome: receipt.kind, error: receipt.error };
      }
      const pending = consumePairing(db, input.pairingCode, "agent");
      if (!pending)
        return { outcome: "invalid", error: "invalid or expired pairing code" } as const;
      if (
        pending.scopes.length !== 1 ||
        pending.scopes[0] !== SCOPE_SUBSCRIPTIONS_RECEIVE ||
        input.capabilities.agentIntegration?.harness !== input.harness
      ) {
        throw new Error("invalid agent integration pairing contract");
      }

      if ((pending.repairDeviceId ?? undefined) !== input.repairDeviceId) {
        throw new Error("pairing repair target changed");
      }

      const repairTarget = pending.repairDeviceId ? getDevice(db, pending.repairDeviceId) : null;
      if (pending.repairDeviceId && !repairTarget) {
        throw new Error("pairing repair target no longer exists");
      }
      if (
        repairTarget &&
        (repairTarget.kind !== "agent" ||
          repairTarget.capabilities.agentIntegration?.harness !== input.harness)
      ) {
        throw new Error("pairing repair target is not the same agent integration");
      }

      const name =
        repairTarget?.name ?? resolveDeviceName(pending.name, "agent", input.capabilities);
      const existing = findDeviceByName(db, name);
      let device: DeviceRecord;
      if (repairTarget) {
        if (!existing || existing.id !== repairTarget.id) {
          throw new Error("pairing repair target changed");
        }
        device = replaceDeviceForRepair(db, repairTarget.id, {
          name,
          kind: "agent",
          capabilities: input.capabilities,
        });
      } else {
        if (existing) {
          throw new Error(`device name conflict: ${name}`);
        }
        device = createDevice(db, { name, kind: "agent", capabilities: input.capabilities });
      }
      db.prepare("UPDATE devices SET self_emails = ?, self_phones = ? WHERE id = ?").run(
        JSON.stringify(pending.selfEmails),
        JSON.stringify(pending.selfPhones),
        device.id,
      );
      device = { ...device, selfEmails: pending.selfEmails, selfPhones: pending.selfPhones };

      const ingestionScope = writeScope(SourceType(input.harness));
      const withScopes = (token: ReturnType<typeof createToken>, scopes: Scope[]) => ({
        ...token,
        scopes,
      });
      const credentials = {
        delivery: withScopes(
          createToken(
            db,
            device.id,
            [SCOPE_SUBSCRIPTIONS_RECEIVE],
            `${input.harness}-subscription-delivery`,
          ),
          [SCOPE_SUBSCRIPTIONS_RECEIVE],
        ),
        ingestion: withScopes(
          createToken(db, device.id, [ingestionScope], `${input.harness}-conversation-ingestion`),
          [ingestionScope],
        ),
        management: withScopes(
          createToken(db, device.id, [SCOPE_SUBSCRIPTIONS_MANAGE], `${input.harness}-management`),
          [SCOPE_SUBSCRIPTIONS_MANAGE],
        ),
      };
      const result = { outcome: "paired", pending, device, credentials, replayed: false } as const;
      if (input.idempotencyKey) {
        writePairingReceipt(
          db,
          input.pairingCode,
          input.idempotencyKey,
          requestFingerprint,
          result,
        );
      }
      return result;
    })();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "invalid agent integration pairing contract") {
      return { outcome: "invalid", error: message };
    }
    return { outcome: "conflict", error: message };
  }
}

export function cleanupExpiredPairings(db: Db): number {
  const cutoff = now();
  const pairings = db.prepare("DELETE FROM device_pairings WHERE expires_at < ?").run(cutoff);
  const receipts = db
    .prepare("DELETE FROM pairing_redemption_receipts WHERE expires_at < ?")
    .run(cutoff);
  return pairings.changes + receipts.changes;
}

type PairedAgentIntegration = Extract<AgentIntegrationPairingResult, { outcome: "paired" }>;

function agentPairingRequestFingerprint(input: {
  harness: "openclaw" | "hermes";
  capabilities: DeviceCapability;
}): string {
  return hashPairingReceiptValue(
    `request\0${canonicalJson({ harness: input.harness, capabilities: input.capabilities })}`,
  );
}

function devicePairingRequestFingerprint(capabilities: DeviceCapability): string {
  return hashPairingReceiptValue(`request\0${canonicalJson({ kind: "device", capabilities })}`);
}

// The two domain-separation labels below still carry the "agent" name the
// receipts were introduced under: changing them would invalidate receipts
// sealed before an upgrade, and the label is an opaque salt, not a description.
function hashPairingReceiptValue(value: string): string {
  return createHash("sha256")
    .update("omnesis-agent-pairing-receipt-v1\0")
    .update(value)
    .digest("hex");
}

function pairingReceiptKey(pairingCode: string, idempotencyKey: string): Buffer {
  return createHash("sha256")
    .update("omnesis-agent-pairing-receipt-key-v1\0")
    .update(pairingCode)
    .update("\0")
    .update(idempotencyKey)
    .digest();
}

/** What a receipt lookup yields: the sealed result, a verdict, or nothing on file. */
type PairingReceipt<T> =
  | { kind: "replay"; result: T }
  | { kind: "invalid"; error: string }
  | { kind: "conflict"; error: string };

/**
 * Seal a redemption result under a key derived from the code and the client's
 * idempotency key, bound to the request fingerprint. Only the exact same
 * request can read it back, and only until the receipt expires.
 */
function writePairingReceipt<T>(
  db: Db,
  pairingCode: string,
  idempotencyKey: string,
  requestFingerprint: string,
  result: T,
): void {
  const createdAt = now();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", pairingReceiptKey(pairingCode, idempotencyKey), iv);
  cipher.setAAD(Buffer.from(requestFingerprint, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(result), "utf8"), cipher.final()]);
  const sealedResponse = JSON.stringify({
    version: 1,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  });
  db.prepare(
    `INSERT INTO pairing_redemption_receipts
       (idempotency_key_hash, pairing_code_hash, request_fingerprint,
        sealed_response, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    hashPairingReceiptValue(`idempotency\0${idempotencyKey}`),
    hashPairingReceiptValue(`pairing-code\0${pairingCode}`),
    requestFingerprint,
    sealedResponse,
    createdAt,
    createdAt + PAIRING_RECEIPT_TTL_MS,
  );
}

function readPairingReceipt<T>(
  db: Db,
  pairingCode: string,
  idempotencyKey: string,
  requestFingerprint: string,
): PairingReceipt<T> | null {
  const keyHash = hashPairingReceiptValue(`idempotency\0${idempotencyKey}`);
  const row = db
    .prepare<
      [string],
      {
        pairing_code_hash: string;
        request_fingerprint: string;
        sealed_response: string;
        expires_at: number;
      }
    >(
      `SELECT pairing_code_hash, request_fingerprint, sealed_response, expires_at
       FROM pairing_redemption_receipts
       WHERE idempotency_key_hash = ?`,
    )
    .get(keyHash);
  if (!row) return null;
  if (row.expires_at < now()) {
    db.prepare("DELETE FROM pairing_redemption_receipts WHERE idempotency_key_hash = ?").run(
      keyHash,
    );
    return { kind: "invalid", error: "expired pairing redemption receipt" };
  }
  if (
    row.pairing_code_hash !== hashPairingReceiptValue(`pairing-code\0${pairingCode}`) ||
    row.request_fingerprint !== requestFingerprint
  ) {
    return { kind: "conflict", error: "pairing idempotency key was reused" };
  }
  try {
    const sealed = JSON.parse(row.sealed_response) as {
      version: number;
      iv: string;
      ciphertext: string;
      tag: string;
    };
    if (sealed.version !== 1) throw new Error("unsupported receipt version");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      pairingReceiptKey(pairingCode, idempotencyKey),
      Buffer.from(sealed.iv, "base64url"),
      { authTagLength: GCM_TAG_BYTES },
    );
    decipher.setAAD(Buffer.from(requestFingerprint, "utf8"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return { kind: "replay", result: JSON.parse(plaintext) as T };
  } catch {
    return { kind: "conflict", error: "pairing redemption receipt is invalid" };
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// ── Self bootstrap from device annotation (#282) ──────────────────────────
//
// When the operator runs `omnesis devices set-self` on a fresh install
// (no contacts source synced yet), the gateway has no canonical self
// person. Sources that emit `isSelf: true` mentions (Things, Obsidian,
// Apple Notes/Reminders) silently drop those mentions — the
// short-circuit in `findOrCreatePerson` returns null when no self exists.
//
// `bootstrapSelfFromDevices` runs once at gateway boot, AFTER
// `seedFromContacts` has had its turn. If a canonical self already
// exists (because contacts seeded it, or a previous boot ran this
// helper) we leave it alone — the contact-card derivation is richer
// (carries names, addresses, social profiles).
//
// Only when no canonical self exists AND at least one device has
// non-empty self info do we materialize a self person from the device
// annotation. Multiple devices with self info: pick the
// chronologically-first device (lowest `paired_at`) and warn — one
// canonical self per Omnesis install. The other devices' annotations
// stay on their rows for diagnostic visibility.

/**
 * Boot-time bootstrap: if no canonical self person exists, materialize
 * one from any device that has self info. Returns the new person's id
 * if it created one, or null if a canonical self already exists / no
 * device has self info.
 *
 * Idempotent: calling again with a self person already present is a
 * no-op (returns null without writing anything).
 */
export function bootstrapSelfFromDevices(db: Db): string | null {
  const existing = db
    .prepare<
      [],
      { id: string }
    >("SELECT id FROM people WHERE is_self = TRUE AND merged_into IS NULL LIMIT 1")
    .get();
  if (existing) return null;

  const devicesWithSelf = listDevices(db).filter(
    (d) => !d.revokedAt && (d.selfEmails.length > 0 || d.selfPhones.length > 0),
  );
  if (devicesWithSelf.length === 0) return null;

  // listDevices already orders by paired_at ASC — the first entry is
  // the chronologically-earliest device with self annotation. The
  // remaining ones (if any) get a warning so the operator knows their
  // annotation isn't seeding a separate self.
  const winner = devicesWithSelf[0];
  if (devicesWithSelf.length > 1) {
    log.warn(
      `Multiple devices carry self annotation [${devicesWithSelf
        .map((d) => `${d.name}(emails=${d.selfEmails.length},phones=${d.selfPhones.length})`)
        .join(", ")}]; bootstrapping self from earliest-paired device "${winner.name}" only`,
    );
  }

  const personId = randomUUID();
  const nowIso = new Date().toISOString();
  // Pick the first email or phone as the canonical name placeholder —
  // contacts seeding (when it eventually runs) will overwrite this with
  // a real display name. Until then any string is fine.
  const canonicalName = winner.selfEmails[0] ?? winner.selfPhones[0] ?? "Self";

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
       VALUES (?, ?, 'device', TRUE, ?, ?, ?, ?)`,
    ).run(personId, canonicalName, nowIso, nowIso, nowIso, nowIso);

    const aliases = aliasWriter(db, `device:${winner.id}`, nowIso);
    for (const email of winner.selfEmails) aliases.claim(personId, "email", email);
    for (const phone of winner.selfPhones) aliases.claim(personId, "phone", phone);
    // Self is the centre every interaction score is measured against, so a
    // freshly-materialized self has to flag a recompute.
    markPeopleGraphDirty(db);
  });
  tx();

  log.info(
    `Bootstrapped canonical self person ${personId} from device "${winner.name}" (${winner.selfEmails.length} emails, ${winner.selfPhones.length} phones)`,
  );
  return personId;
}
