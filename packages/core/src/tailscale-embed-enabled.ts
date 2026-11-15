// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Explicit, independent opt-in for the gateway's own embedded Tailscale device.
 * Experimental and synthetic mode never enable it, and an Omnesis that merely
 * finds Tailscale installed on its computer keeps working the same without it.
 */
export function tailscaleEmbedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMNESIS_TAILSCALE_EMBED_ENABLED === "1";
}
