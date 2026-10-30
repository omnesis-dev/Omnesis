// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { collectorHostname } from "@omnesis/core";

/**
 * Display name this collector registers as in the gateway's device
 * registry — shown in the Sources list (iOS app and portal) as the host
 * that synced each source.
 *
 * Defaults to `<machine-hostname>-collector`. `OMNESIS_COLLECTOR_HOSTNAME`
 * overrides the hostname portion (see `collectorHostname`): containers and CI
 * runners have opaque hostnames, the Docker installer's combined container
 * answers to `gateway`, and the synthetic demo gateway sets it so
 * landing-page captures show a neutral host instead of the operator's real
 * machine.
 */
export function collectorDeviceName(): string {
  return `${collectorHostname()}-collector`;
}
