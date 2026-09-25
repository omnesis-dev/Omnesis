// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { DEFAULT_PUSH_RELAY_URL, type OmnesisConfig } from "@omnesis/config";

/** Resolve the relay origin and its legacy global setting for response compatibility. */
export function resolveRelaySettings(config: OmnesisConfig): {
  /** @deprecated Relay authorization is recorded per device. */
  enabled: boolean;
  url: string;
  visible: true;
} {
  const relay = config.gateway?.pushRelay;
  return {
    enabled: relay?.enabled ?? false,
    url: relay?.url ?? DEFAULT_PUSH_RELAY_URL,
    visible: true,
  };
}
