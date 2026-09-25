// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import {
  SourceId as makeSourceId,
  SourceType as makeSourceType,
  DeviceId as makeDeviceId,
} from "@omnesis/types";
import {
  canonicalMemberScopedParamNames,
  advertisedMemberScopedParamNames,
  splitMemberScopedParams,
  deviceMatchesMemberConfigContract,
  deviceSupportsMultiDeviceMode,
} from "../../multi-device-mode.js";
import { getDevice } from "./DeviceRepository.js";
import type { DeviceId, DeviceRecord, SourceId, SourceType } from "@omnesis/types";
import type { SourceRecord } from "./SourceRepository.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const storedContractSchema = z.array(z.string().min(1).max(128));

export function createSourceMemberConfigContractTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_member_config_contracts (
      source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
      param_names TEXT NOT NULL
    )
  `);
}

function parseStoredContract(sourceId: SourceId, raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`source ${sourceId} has a corrupt member-local configuration contract`);
  }
  const validated = storedContractSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`source ${sourceId} has a corrupt member-local configuration contract`);
  }
  const canonical = canonicalMemberScopedParamNames(validated.data);
  if (JSON.stringify(canonical) !== JSON.stringify(validated.data)) {
    throw new Error(`source ${sourceId} has a non-canonical member-local configuration contract`);
  }
  return canonical;
}

/** The source-lifetime member-local parameter contract; null means legacy/uninitialized. */
export function getSourceMemberConfigContract(db: Db, sourceId: SourceId): string[] | null {
  const row = db
    .prepare<
      [string],
      { param_names: string }
    >("SELECT param_names FROM source_member_config_contracts WHERE source_id = ?")
    .get(sourceId);
  return row ? parseStoredContract(sourceId, row.param_names) : null;
}

type PersistedSourceContract = Pick<
  SourceRecord,
  "id" | "type" | "multiDeviceMode" | "replicaVersionPolicy"
>;

function deviceSupportsStorageContract(
  source: PersistedSourceContract,
  device: DeviceRecord,
): boolean {
  return (
    deviceSupportsMultiDeviceMode(device, source.type, source.multiDeviceMode) &&
    (source.multiDeviceMode !== "replicated" ||
      device.capabilities.replicaVersionPolicies?.[source.type] ===
        (source.replicaVersionPolicy ?? undefined))
  );
}

/** Exact agreement is required to change membership or configuration scope. */
export function deviceSupportsPersistedSourceContract(
  db: Db,
  source: PersistedSourceContract,
  device: DeviceRecord,
  expectedMemberConfig = getSourceMemberConfigContract(db, source.id),
): boolean {
  return (
    deviceSupportsStorageContract(source, device) &&
    (expectedMemberConfig === null ||
      deviceMatchesMemberConfigContract(device, source.type, expectedMemberConfig))
  );
}

/**
 * An existing host can execute a pinned contract while advertising additional
 * member-local fields. Delivery still contains only its own effective config;
 * this does not promote shared values, repin the contract, or authorize member-local config
 * mutations. Missing fields, modes and replica policies remain incompatible.
 */
export function deviceSupportsExistingSourceExecution(
  db: Db,
  source: PersistedSourceContract & Pick<SourceRecord, "deviceId">,
  device: DeviceRecord,
): boolean {
  if (
    source.deviceId !== device.id &&
    !db
      .prepare("SELECT 1 FROM source_devices WHERE source_id = ? AND device_id = ?")
      .get(source.id, device.id)
  )
    return false;
  if (!deviceSupportsStorageContract(source, device)) return false;
  const expected = getSourceMemberConfigContract(db, source.id);
  if (expected === null) return true;
  const advertised = advertisedMemberScopedParamNames(device, source.type);
  return advertised !== null && expected.every((name) => advertised.includes(name));
}

/**
 * Freeze a legacy source's contract or verify an existing one. Call inside
 * the lifecycle writer transaction so a create, join, move, or transition
 * cannot observe one contract and commit under another.
 */
export function initializeOrAssertSourceMemberConfigContract(
  db: Db,
  sourceId: SourceId,
  expectedNames: readonly string[],
): string[] {
  const expected = canonicalMemberScopedParamNames(expectedNames);
  db.prepare(
    `INSERT OR IGNORE INTO source_member_config_contracts (source_id, param_names)
     VALUES (?, ?)`,
  ).run(sourceId, JSON.stringify(expected));
  const stored = getSourceMemberConfigContract(db, sourceId);
  if (!stored || JSON.stringify(stored) !== JSON.stringify(expected)) {
    throw new Error(
      `source ${sourceId} member-local configuration contract does not match this device`,
    );
  }
  return stored;
}

/** Revalidate a device's current advertisement in the same write transaction. */
export function initializeOrAssertSourceMemberConfigContractForDevice(
  db: Db,
  sourceId: SourceId,
  sourceType: SourceType,
  deviceId: DeviceId,
  expectedNames: readonly string[] | undefined,
): string[] | null {
  if (expectedNames === undefined) return getSourceMemberConfigContract(db, sourceId);
  const device = getDevice(db, deviceId);
  if (!device || !deviceMatchesMemberConfigContract(device, sourceType, expectedNames)) {
    throw new Error(
      `device ${deviceId} no longer advertises source ${sourceId}'s member-local configuration contract`,
    );
  }
  return initializeOrAssertSourceMemberConfigContract(db, sourceId, expectedNames);
}

/**
 * Extend contracts only after every current member advertises the same set.
 * Called in the hello writer transaction. Moving shared values into overlays
 * preserves each member's effective config; contractions must be explicit
 * because promoting a formerly local value would disclose it to siblings.
 */
export function extendUnanimousMemberConfigContracts(db: Db, deviceId: DeviceId): SourceId[] {
  const changed: SourceId[] = [];
  const sources = db
    .prepare<[string], { id: string; type: string; config: string }>(
      `
    SELECT s.id, s.type, s.config FROM sources s
    JOIN source_devices m ON m.source_id = s.id
    WHERE m.device_id = ?
      AND NOT EXISTS (SELECT 1 FROM source_mode_transitions t WHERE t.source_id = s.id)
  `,
    )
    .all(deviceId);
  const record = z.record(z.string(), z.unknown());
  for (const source of sources) {
    const sourceId = makeSourceId(source.id);
    const stored = getSourceMemberConfigContract(db, sourceId);
    if (stored === null) continue;
    const members = db
      .prepare<
        [string],
        { device_id: string; config_override: string }
      >("SELECT device_id, config_override FROM source_devices WHERE source_id = ?")
      .all(sourceId);
    const contracts = members.map((member) => {
      const device = getDevice(db, makeDeviceId(member.device_id));
      return device ? advertisedMemberScopedParamNames(device, makeSourceType(source.type)) : null;
    });
    const next = contracts[0];
    if (
      !next ||
      !stored.every((name) => next.includes(name)) ||
      JSON.stringify(next) === JSON.stringify(stored) ||
      contracts.some((names) => JSON.stringify(names) !== JSON.stringify(next))
    )
      continue;

    // Parse everything before mutating anything; corrupt config never turns
    // into an empty replacement and a lost local path.
    const config = record.parse(JSON.parse(source.config));
    const { sharedConfig, memberParams } = splitMemberScopedParams(config, next);
    const overrides = members.map((member) => {
      const override = record.parse(JSON.parse(member.config_override));
      const params = override.params === undefined ? {} : record.parse(override.params);
      return { ...member, config: { ...override, params: { ...memberParams, ...params } } };
    });
    for (const member of overrides) {
      db.prepare(
        "UPDATE source_devices SET config_override = ? WHERE source_id = ? AND device_id = ?",
      ).run(JSON.stringify(member.config), sourceId, member.device_id);
    }
    db.prepare("UPDATE sources SET config = ? WHERE id = ?").run(
      JSON.stringify(sharedConfig),
      sourceId,
    );
    db.prepare("UPDATE source_member_config_contracts SET param_names = ? WHERE source_id = ?").run(
      JSON.stringify(next),
      sourceId,
    );
    changed.push(sourceId);
  }
  return changed;
}
