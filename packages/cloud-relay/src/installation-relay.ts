// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { relayOrigin } from "./network.js";

/** Distribution service; operator configuration and existing installations take precedence. */
export const DEFAULT_INSTALLATION_RELAY_URL = "https://relay.omnesis.app";

/**
 * The DNS broker that alone may prove control of the official relay's gateway names. Compiled
 * in like the relay itself, and never taken from anything the relay says.
 */
export const OFFICIAL_DNS_BROKER_URL = "https://dns.omnesis.app";

/**
 * A synthetic, isolated test or spawned E2E gateway is not a real installation: it talks to a
 * relay only when one is named for it, never to the distribution service by default.
 */
function testInstallation(env: NodeJS.ProcessEnv): boolean {
  return (
    env.OMNESIS_SYNTHETIC === "1" ||
    env.OMNESIS_TEST_INSTANCE === "1" ||
    env.OMNESIS_E2E_DISABLE_DEFAULT_RELAY === "1"
  );
}

/** Request input is deliberately absent: only local installation state selects the service. */
export function installationRelayUrl(env: NodeJS.ProcessEnv, saved?: string): string | undefined {
  const selected =
    env.OMNESIS_CLOUD_RELAY_URL ??
    saved ??
    (testInstallation(env) ? undefined : DEFAULT_INSTALLATION_RELAY_URL);
  if (selected === undefined) return undefined;
  try {
    return relayOrigin(selected).origin;
  } catch {
    return undefined;
  }
}
