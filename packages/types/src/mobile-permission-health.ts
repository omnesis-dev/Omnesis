// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const MOBILE_PERMISSION_STATES = [
  "healthy",
  "permission-degraded",
  "background-access-missing",
  "unavailable",
  "unknown",
] as const;

export type MobilePermissionState = (typeof MOBILE_PERMISSION_STATES)[number];

export const MOBILE_PERMISSION_REQUIREMENTS = ["required", "optional"] as const;
export type MobilePermissionRequirement = (typeof MOBILE_PERMISSION_REQUIREMENTS)[number];

export const MOBILE_PERMISSION_REPAIR_ACTIONS = [
  "open-source-settings",
  "open-app-settings",
  "open-system-settings",
  "none",
] as const;
export type MobilePermissionRepairAction = (typeof MOBILE_PERMISSION_REPAIR_ACTIONS)[number];

export interface MobilePermissionCapability {
  id: string;
  label: string;
  state: MobilePermissionState;
  requirement: MobilePermissionRequirement;
  impact?: string;
  remediation?: string;
  repairAction: MobilePermissionRepairAction;
}

export interface MobilePermissionHealthReport {
  checkedAt: number;
  validForMs: number;
  capabilities: MobilePermissionCapability[];
}

export interface MobilePermissionHealth {
  state: MobilePermissionState;
  reportedState: MobilePermissionState;
  checkedAt: number;
  receivedAt: number;
  validUntil: number;
  reportStale: boolean;
  capabilities: MobilePermissionCapability[];
}

export function isActionableMobilePermissionState(
  state: MobilePermissionState,
): state is "permission-degraded" | "background-access-missing" | "unavailable" {
  return (
    state === "permission-degraded" ||
    state === "background-access-missing" ||
    state === "unavailable"
  );
}

const STATE_PRIORITY: Readonly<Record<MobilePermissionState, number>> = {
  unavailable: 4,
  "background-access-missing": 3,
  "permission-degraded": 2,
  unknown: 1,
  healthy: 0,
};

/** Aggregate a complete capability snapshot without inferring from source data volume. */
export function aggregateMobilePermissionState(
  capabilities: readonly MobilePermissionCapability[],
): MobilePermissionState {
  return aggregateDrivingMobilePermissionCapability(capabilities)?.state ?? "healthy";
}

/** Return the capability whose severity and requirement determine the aggregate state. */
export function aggregateDrivingMobilePermissionCapability(
  capabilities: readonly MobilePermissionCapability[],
): MobilePermissionCapability | undefined {
  let selected: MobilePermissionCapability | undefined;
  let selectedPriority = 0;
  for (const capability of capabilities) {
    // Any actionable loss outranks `unknown`; required only breaks ties
    // within the same broad severity instead of hiding optional data loss.
    const priority =
      STATE_PRIORITY[capability.state] * 10 + (capability.requirement === "required" ? 1 : 0);
    if (capability.state !== "healthy" && priority > selectedPriority) {
      selected = capability;
      selectedPriority = priority;
    }
  }
  return selected;
}
