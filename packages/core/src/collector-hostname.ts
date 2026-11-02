// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { hostname as osHostname } from "node:os";

/** Names the machine a collector reports, in place of the system hostname. */
export const COLLECTOR_HOSTNAME_ENV = "OMNESIS_COLLECTOR_HOSTNAME";

/**
 * The machine name a collector reports for itself: the `hostname` capability
 * it registers and connects with, and the stem of its `<name>-collector`
 * device name.
 *
 * `OMNESIS_COLLECTOR_HOSTNAME` overrides the system hostname, which in a
 * container is the container's own: the Docker installer's combined container
 * answers to `gateway` (the name its certificate carries) and sets this to the
 * host's name, and the synthetic demo gateway sets it so captures show a
 * neutral host. Every comparison with a collector's reported hostname —
 * "is this CLI on the collector's machine?" — reads this same function, so a
 * CLI running beside the collector in that container still matches it.
 */
export function collectorHostname(
  env: NodeJS.ProcessEnv = process.env,
  systemHostname: () => string = osHostname,
): string {
  const override = env[COLLECTOR_HOSTNAME_ENV]?.trim();
  return override ? override : systemHostname();
}

/**
 * The stem a device name is built from, out of a raw hostname: the first DNS
 * label, lowercased, with anything but letters, digits and hyphens turned
 * into a hyphen, and at most 63 characters. A Mac reports its Bonjour name
 * (`Maya-MacBook.local`), whose `.local` is an mDNS suffix rather than part of
 * the machine's name; the Docker installer derives the name of the collector
 * it runs from `hostname -s` with exactly this rule, so a native collector and
 * a container on the same machine carry the same stem. Empty when nothing of
 * the hostname survives.
 */
export function hostNameStem(raw: string): string {
  const label = raw.trim().split(".")[0] ?? "";
  return label
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, 63)
    .replace(/-+$/u, "");
}

/**
 * The machine name a device registers under: the override a container is
 * given, as given, or the stem of the system hostname — falling back to the
 * raw hostname when it has no stem at all.
 */
export function deviceNameHost(
  env: NodeJS.ProcessEnv = process.env,
  systemHostname: () => string = osHostname,
): string {
  const override = env[COLLECTOR_HOSTNAME_ENV]?.trim();
  if (override) return override;
  const raw = systemHostname();
  return hostNameStem(raw) || raw;
}
