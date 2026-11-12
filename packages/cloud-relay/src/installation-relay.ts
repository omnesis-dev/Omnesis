// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { relayOrigin } from "./network.js";

/** Distribution service; operator configuration and existing installations take precedence. */
export const DEFAULT_INSTALLATION_RELAY_URL = "https://relay.omnesis.app";

/** Request input is deliberately absent: only local installation state selects the service. */
export function installationRelayUrl(env: NodeJS.ProcessEnv, saved?: string): string | undefined {
  try {
    return relayOrigin(env.OMNESIS_CLOUD_RELAY_URL ?? saved ?? DEFAULT_INSTALLATION_RELAY_URL)
      .origin;
  } catch {
    return undefined;
  }
}
