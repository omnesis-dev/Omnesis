// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { hostname as osHostname } from "node:os";

/**
 * Display name this collector registers as in the gateway's device
 * registry — shown in the Sources list (iOS app and portal) as the host
 * that synced each source.
 *
 * Defaults to `<machine-hostname>-collector`. `OMNESIS_COLLECTOR_HOSTNAME`
 * overrides the hostname portion: containers and CI runners have opaque
 * hostnames, and the synthetic demo gateway sets it so landing-page
 * captures show a neutral host instead of the operator's real machine.
 */
export function collectorDeviceName(): string {
  const override = process.env.OMNESIS_COLLECTOR_HOSTNAME?.trim();
  return `${override && override.length > 0 ? override : osHostname()}-collector`;
}
