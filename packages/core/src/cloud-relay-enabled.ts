// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Explicit, independent opt-in; experimental and synthetic mode never enable cloud connectivity. */
export function cloudRelayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMNESIS_CLOUD_RELAY_ENABLED === "1";
}
