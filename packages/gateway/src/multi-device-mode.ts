// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  hasPerDeviceCursor,
  isMultiDeviceMode,
  type DeviceRecord,
  type MultiDeviceMode,
  type SourceType,
} from "@omnesis/types";

/**
 * Resolve the mode to pin when one device creates a source. A different,
 * newer collector must never decide the new row's storage contract.
 */
export function resolveDeviceMultiDeviceMode(
  device: DeviceRecord | null | undefined,
  sourceType: string,
): MultiDeviceMode {
  const announced = device?.capabilities.multiDeviceModes?.[sourceType];
  if (announced && isMultiDeviceMode(announced)) return announced;
  return "exclusive";
}

/**
 * Whether a host implements the persisted storage contract for one source.
 * Handoff infrastructure exists for acceptance testing, but no built-in
 * source advertises it as a production capability. A provider must prove its
 * own backfill, lease-loss, auth-release, and deletion behavior before opting
 * in; until then its descriptor remains exclusive.
 *
 * Every source-hosting client is separately deployed, so its exact mode
 * announcement is required. Lease-backed modes also require the lease
 * capability: accepting an older collector or phone would restore unsafe
 * deletion/cursor behavior. Exclusive stays compatible with clients that
 * predate capability negotiation.
 */
export function deviceSupportsMultiDeviceMode(
  device: DeviceRecord,
  sourceType: SourceType,
  mode: MultiDeviceMode,
): boolean {
  if (mode === "exclusive") return true;
  if (device.capabilities.multiDeviceModes?.[sourceType] !== mode) return false;
  return (mode !== "handoff" && mode !== "replicated") || device.capabilities.syncLease === true;
}

/** Canonical identity for a descriptor's order-insensitive member parameter set. */
export function canonicalMemberScopedParamNames(names: readonly string[]): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * Remove descriptor-declared member-local params from a shared source config.
 * Lifecycle code may persist the extracted values in one member's overlay;
 * callers that only consume `sharedConfig` prevent host-local paths from
 * leaking to sibling members.
 */
export function splitMemberScopedParams(
  config: Record<string, unknown>,
  memberScopedParams: readonly string[],
): { sharedConfig: Record<string, unknown>; memberParams: Record<string, unknown> } {
  const params = plainRecord(config.params);
  if (!params || memberScopedParams.length === 0) {
    return { sharedConfig: config, memberParams: {} };
  }

  const sharedParams = { ...params };
  const memberParams: Record<string, unknown> = {};
  for (const name of canonicalMemberScopedParamNames(memberScopedParams)) {
    if (!Object.hasOwn(params, name)) continue;
    memberParams[name] = params[name];
    delete sharedParams[name];
  }
  if (Object.keys(memberParams).length === 0) {
    return { sharedConfig: config, memberParams };
  }

  const sharedConfig = { ...config };
  if (Object.keys(sharedParams).length === 0) delete sharedConfig.params;
  else sharedConfig.params = sharedParams;
  return { sharedConfig, memberParams };
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Null means a separately deployed collector does not implement the contract. */
export function advertisedMemberScopedParamNames(
  device: DeviceRecord,
  sourceType: SourceType,
): string[] | null {
  if (device.kind !== "collector") return [];
  const byType = device.capabilities.memberScopedParams;
  if (!byType || !Object.hasOwn(byType, sourceType)) return null;
  return canonicalMemberScopedParamNames(byType[sourceType] ?? []);
}

export function deviceMatchesMemberConfigContract(
  device: DeviceRecord,
  sourceType: SourceType,
  expectedNames: readonly string[],
): boolean {
  const advertised = advertisedMemberScopedParamNames(device, sourceType);
  return (
    advertised !== null &&
    JSON.stringify(advertised) === JSON.stringify(canonicalMemberScopedParamNames(expectedNames))
  );
}

/**
 * The `sync_state` row a device's cursor writes land on: its own row when
 * the type keeps per-device cursors and the caller is a device, the shared
 * row (`""`) otherwise — which is also what a caller without a device
 * identity (an admin token) reads and writes.
 */
export function cursorDeviceFor(mode: MultiDeviceMode, deviceId: string | null): string {
  if (!deviceId) return "";
  return hasPerDeviceCursor(mode) ? deviceId : "";
}
