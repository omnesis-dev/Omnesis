// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { deviceNameHost } from "@omnesis/core";

/**
 * Display name this collector registers as in the gateway's device
 * registry — shown in the Sources list (iOS app and portal) as the host
 * that synced each source.
 *
 * Defaults to `<host>-collector`, where `<host>` is the stem of the machine's
 * hostname (`hostNameStem`: a Mac's `Maya-MacBook.local` reads `maya-macbook`),
 * the rule the Docker installer names its container's collector by.
 * `OMNESIS_COLLECTOR_HOSTNAME` overrides the host portion as given:
 * containers and CI runners have opaque hostnames, the Docker installer's
 * combined container answers to `gateway`, and the synthetic demo gateway sets
 * it so landing-page captures show a neutral host instead of the operator's
 * real machine. A collector that has paired keeps the name the gateway gave
 * it (its pairing record), so this only names a first registration.
 */
export function collectorDeviceName(): string {
  return `${deviceNameHost()}-collector`;
}
