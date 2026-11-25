// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import {
  DeviceId,
  hasPerDeviceCursor,
} from "@omnesis/types";
import { agentDeviceRevocationImpact } from "../../access/agent-device-authorization.js";
import { getDevice } from "./DeviceRepository.js";
import {
  deleteSource,
  getSource,
  isSourceModeTransitionPending,
  listSourceMembers,
  listSourcesForMember,
  markSourceRemoved,
  removeSourceMember,
} from "./SourceRepository.js";
import { bumpWipeEpoch } from "./SyncStateRepository.js";
import type { SourceId,
  DeviceKind,
  MultiDeviceMode } from "@omnesis/types";
import type { SourceStreamCleanupJob } from "./SourceStreamCleanupRepository.js";
import type { Db } from "../types.js";

export interface DeviceForgetOptions {
  data: "keep" | "delete";
  impactFingerprint: string;
}

export interface DeviceForgetImpactSource {
  id: SourceId;
  type: string;
  multiDeviceMode: MultiDeviceMode;
  otherDeviceCount: number;
  deleteScope: "source" | "partition" | "none";
}

export interface DeviceForgetImpact {
  sources: DeviceForgetImpactSource[];
  fingerprint: string;
}

export interface ArchivedSourceDevice {
  deviceId: DeviceId;
  name: string;
  kind: DeviceKind;
  forgottenAt: number;
}

export function isDeviceForgotten(db: Db, id: string): boolean {
  return db.prepare("SELECT 1 FROM forgotten_devices WHERE device_id = ?").get(id) !== undefined;
}

/** Immutable origin labels for retained streams; these identities cannot sync. */
export function sourceArchivedDevices(db: Db, id: SourceId): ArchivedSourceDevice[] {
  return db
    .prepare<[string], { device_id: string; name: string; kind: DeviceKind; forgotten_at: number }>(
      `SELECT f.device_id, f.name, f.kind, f.forgotten_at
       FROM source_device_archives a JOIN forgotten_devices f ON f.device_id = a.device_id
      WHERE a.source_id = ? ORDER BY a.archived_at, a.device_id`,
    )
    .all(id)
    .map((row) => ({
      deviceId: DeviceId(row.device_id),
      name: row.name,
      kind: row.kind,
      forgottenAt: row.forgotten_at,
    }));
}

/** The reviewed roster and storage semantics, fenced again inside the writer. */
export function deviceForgetImpact(db: Db, id: DeviceId): DeviceForgetImpact | null {
  const device = getDevice(db, id);
  if (!device) return null;
  const roster = listSourcesForMember(db, id).sort((a, b) => a.id.localeCompare(b.id));
  const state = roster.map((source) => ({
    id: source.id,
    type: source.type,
    mode: source.multiDeviceMode,
    replicaVersionPolicy: source.replicaVersionPolicy,
    createdAt: source.createdAt,
    owner: source.deviceId,
    members: listSourceMembers(db, source.id)
      .map((member) => member.deviceId)
      .sort(),
    archived: sourceArchivedDevices(db, source.id)
      .map((member) => member.deviceId)
      .sort(),
    transitionPending: isSourceModeTransitionPending(db, source.id),
  }));
  const sources = state.map((source): DeviceForgetImpactSource => {
    const otherDeviceCount = new Set(
      [source.owner, ...source.members].filter((member) => member !== id),
    ).size;
    const hasOtherHistory = source.archived.some((member) => member !== id);
    return {
      id: source.id,
      type: source.type,
      multiDeviceMode: source.mode,
      otherDeviceCount,
      deleteScope:
        otherDeviceCount === 0 && !hasOtherHistory
          ? "source"
          : source.mode === "partitioned"
            ? "partition"
            : "none",
    };
  });
  return {
    sources,
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          device: { id: device.id, name: device.name },
          state,
          corpus:
            device.kind === "agent" ? agentDeviceRevocationImpact(db, id)?.fingerprint : undefined,
        }),
      )
      .digest("hex"),
  };
}

export interface RetiredDeviceSources {
  affectedSourceIds: SourceId[];
  removedSourceIds: SourceId[];
  streamCleanups: SourceStreamCleanupJob[];
}

/**
 * Membership authority and cleanup obligations commit together. Retained
 * data never moves between stream keys; a forgotten origin is provenance,
 * not a sync participant. The caller revokes credentials in this transaction.
 */
export function retireDeviceSources(
  db: Db,
  id: DeviceId,
  data: "keep" | "delete",
): RetiredDeviceSources {
  const device = getDevice(db, id);
  if (!device) throw new Error("Device no longer exists");
  const sources = listSourcesForMember(db, id);
  const impact = deviceForgetImpact(db, id)!;
  for (const source of sources) {
    if (isSourceModeTransitionPending(db, source.id))
      throw new Error("Device sources have a mode transition in progress");
  }
  const result: RetiredDeviceSources = {
    affectedSourceIds: sources.map((source) => source.id),
    removedSourceIds: [],
    streamCleanups: [],
  };
  const at = Date.now();
  db.prepare(
    "INSERT INTO forgotten_devices (device_id, name, kind, forgotten_at) VALUES (?, ?, ?, ?)",
  ).run(id, device.name, device.kind, at);
  for (const source of sources) {
    if (source.deviceId === id && !hasPerDeviceCursor(source.multiDeviceMode))
      bumpWipeEpoch(db, source.id, "");
    const deleteScope = impact.sources.find((entry) => entry.id === source.id)!.deleteScope;
    if (data === "delete" && deleteScope === "source") {
      if (!deleteSource(db, source.id)) throw new Error("Source changed while forgetting device");
      markSourceRemoved(db, source.id, { cleanupPending: true });
      result.removedSourceIds.push(source.id);
      continue;
    }
    const detached = removeSourceMember(db, source.id, id, { keepData: data === "keep" });
    if (!detached.removed) throw new Error(`Cannot retire source membership: ${detached.reason}`);
    if (detached.streamCleanup) result.streamCleanups.push(detached.streamCleanup);
    if (data === "keep") {
      db.prepare(
        "INSERT INTO source_device_archives (source_id, device_id, archived_at) VALUES (?, ?, ?)",
      ).run(source.id, id, at);
    }
    // A legacy shared error has no reporter attribution. Retirement drops that
    // ambiguous aggregate; attributed failures of surviving members stay.
    db.prepare(
      "UPDATE sync_state SET last_error = NULL, errored_at = NULL, last_error_remediation = NULL, last_error_device_id = NULL WHERE source_id = ? AND device_id = '' AND (last_error_device_id = ? OR last_error_device_id IS NULL)",
    ).run(source.id, id);
    if (!getSource(db, source.id)?.enabled) {
      db.prepare("DELETE FROM source_sync_issues WHERE source_id = ?").run(source.id);
    }
  }
  // Release unique pairing identities while preserving the FK anchor. Old
  // enrollment keys are held by revokeDevice, and repairs cannot resolve this row.
  db.prepare(
    "UPDATE devices SET name = ?, install_id = NULL, enrollment_public_key = NULL, capabilities = '{}' WHERE id = ?",
  ).run(`forgotten:${id}`, id);
  db.prepare("DELETE FROM device_pairings WHERE repair_device_id = ?").run(id);
  db.prepare("DELETE FROM reauth_reminders WHERE device_id = ?").run(id);
  return result;
}
