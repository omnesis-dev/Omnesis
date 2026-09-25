// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway's binding of the shared version-ledger logic to its own
 * build: its product version, the wire protocol it speaks, and the declared
 * per-kind floor. Every surface that shows a device's version state — the
 * admin devices list, the doctor, and through them the portal and the CLI —
 * resolves it here, so none of them can reach a different verdict about the
 * same device.
 */

import {
  MINIMUM_CLIENT_VERSIONS,
  PROTOCOL_VERSION,
  computeClientVersionState,
  summarizeFleetVersions,
  type ClientVersionState,
  type FleetVersionSummary,
} from "@omnesis/core";
import { GATEWAY_VERSION } from "./version.js";
import type { DeviceKind } from "@omnesis/types";

/** The slice of a device row the verdict is computed from. */
export interface VersionedDevice {
  kind: DeviceKind;
  version: string | null;
  protocolVersion: number | null;
  revokedAt?: number | null;
}

/** This gateway's verdict on one device's build. */
export function deviceVersionState(device: VersionedDevice): ClientVersionState {
  return computeClientVersionState({
    gatewayVersion: GATEWAY_VERSION,
    minimumVersion: MINIMUM_CLIENT_VERSIONS[device.kind],
    reportedVersion: device.version,
    gatewayProtocolVersion: PROTOCOL_VERSION,
    reportedProtocolVersion: device.protocolVersion,
  });
}

/**
 * The fleet in counts. Revoked rows are excluded: they keep their id and
 * their history, but nothing runs on them any more, so counting their stale
 * version reading would inflate every number an operator acts on.
 */
export function fleetVersionSummary(devices: readonly VersionedDevice[]): FleetVersionSummary {
  return summarizeFleetVersions(
    devices.filter((d) => !d.revokedAt).map((d) => deviceVersionState(d)),
  );
}
