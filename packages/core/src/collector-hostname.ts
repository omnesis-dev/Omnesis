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
