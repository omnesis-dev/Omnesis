// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * Descriptor-level icon for the Plaid source: a neoclassical bank front as a
 * white glyph on a rounded near-black tile. It ships as a data URI the source
 * package owns, so every client (portal, iOS) renders it directly with no
 * network fetch and no CDN dependency — the portal CSP forbids remote images,
 * and Omnesis is offline-first. The SF Symbol is the instant-render fallback
 * for surfaces that prefer a system glyph.
 *
 * Deliberately Omnesis's own mark rather than Plaid's. Plaid asks partners to
 * use its official logo files unmodified, and this tile is neither an official
 * file nor unmodified; drawing a bank instead sidesteps the question entirely
 * and costs nothing, because the descriptor icon is only what a connection
 * shows before it has a bank of its own. Once connected, an instance overrides
 * it with the institution's own logo through `SourceInstance.icon` — the one
 * Plaid serves from its institutions endpoint precisely to be displayed. See
 * `TRADEMARKS.md`.
 */
const GLYPH_COLOR = "#FFFFFF";
const TILE_COLOR = "#111111";

// A bank front: pediment, lintel, three columns, plinth. Drawn on the 24x24
// tile directly, symmetric about x=12.
const BANK_GLYPH = [
  '<path d="M12 3.05 21.2 8.15H2.8z"/>',
  '<rect x="3.4" y="9.15" width="17.2" height="1.8" rx=".3"/>',
  '<rect x="5.8" y="11.85" width="2.4" height="6.1" rx=".3"/>',
  '<rect x="10.8" y="11.85" width="2.4" height="6.1" rx=".3"/>',
  '<rect x="15.8" y="11.85" width="2.4" height="6.1" rx=".3"/>',
  '<rect x="3.4" y="18.85" width="17.2" height="2.1" rx=".3"/>',
].join("");

const PLAID_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="${TILE_COLOR}"/><g fill="${GLYPH_COLOR}">${BANK_GLYPH}</g></svg>`;

const plaidIconDataUri = `data:image/svg+xml;base64,${Buffer.from(PLAID_SVG).toString("base64")}`;

/** The system glyph clients without a bundled image fall back to. */
const PLAID_SF_SYMBOL = "building.columns";

/**
 * Chrome tint and dark-mode wash. Distinct from the tile colours: a white
 * accent bar vanishes on a light surface and a near-black wash vanishes on a
 * dark one, so the accent pair is the black mark's own tint and a dimmed
 * version of it, matching the other black-on-white bank marks.
 */
const ACCENT_COLOR = "#111111";
const ACCENT_WASH = "#2E2E31";

export const plaidIcon: SourceIcon = {
  sfSymbol: PLAID_SF_SYMBOL,
  color: ACCENT_COLOR,
  bgColor: ACCENT_WASH,
  imageDataUri: plaidIconDataUri,
};

/**
 * The connected institution's own mark, when Plaid served one at Link time.
 * Plaid returns a base64 PNG and a brand colour; both are decoration, so a
 * missing logo simply leaves the instance on the Plaid mark above.
 *
 * The logo is bounded and checked to be base64 where it is captured, before it
 * is stored — this only assembles the URI.
 */
export function institutionIcon(item: {
  institution_logo?: string;
  institution_color?: string;
}): SourceIcon | undefined {
  if (!item.institution_logo) return undefined;
  return {
    sfSymbol: PLAID_SF_SYMBOL,
    color: normalizeHex(item.institution_color) ?? ACCENT_COLOR,
    bgColor: ACCENT_WASH,
    imageDataUri: `data:image/png;base64,${item.institution_logo}`,
  };
}

/** Accept Plaid's brand colour only in the `#rrggbb` form the icon contract uses. */
function normalizeHex(color: string | undefined): string | undefined {
  if (!color) return undefined;
  const withHash = color.startsWith("#") ? color : `#${color}`;
  return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash.toLowerCase() : undefined;
}
