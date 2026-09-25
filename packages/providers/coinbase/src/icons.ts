// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * Hot-linked at runtime — Coinbase's apple-touch icon served from the official
 * coinbase.com site. See `TRADEMARKS.md` for usage notes.
 *
 * The SF Symbol is iOS's instant-render fallback: a coin reads "crypto wallet"
 * at a glance. Colours follow Coinbase's brand blue; bg is a dimmed wash of the
 * same hue for dark-mode surfaces.
 */
export const coinbaseIcon: SourceIcon = {
  sfSymbol: "bitcoinsign.circle",
  color: "#0052FF",
  bgColor: "#0A1633",
  url: "https://www.coinbase.com/apple-touch-icon.png",
};
