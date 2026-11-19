// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether the relay server process (`@omnesis/cloud-relay`'s `main.ts`) may start. Only that
 * process reads it: gateways, the CLI and collectors offer the account and relay without it.
 */
export function cloudRelayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMNESIS_CLOUD_RELAY_ENABLED === "1";
}
