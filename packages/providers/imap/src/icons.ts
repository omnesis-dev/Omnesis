// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * IMAP host visuals. Known hosts get their own mark where trademark rules
 * allow (Fastmail hot-links its first-party touch icon; iCloud must not —
 * Apple forbids third-party use of its app icons, so it gets a generic
 * cloud). Every other host gets a generic envelope. The generic glyphs are
 * Lucide SVGs (`mail`, `cloud` — ISC-licensed, see `TRADEMARKS.md`), tinted
 * to the accent color and embedded as data URIs so each source's manifest
 * is fully self-contained.
 */

import type { SourceIcon } from "@omnesis/source-sdk";

// ── Lucide source SVGs (ISC-licensed, copied from lucide-static) ──────

const MAIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/></svg>`;

const CLOUD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`;

/** Tint a Lucide stroke SVG by replacing `currentColor` with a hex color. */
function tintLucideSvg(svg: string, color: string): string {
  return svg.replace(/stroke="currentColor"/g, `stroke="${color}"`);
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export const genericImapIcon: SourceIcon = {
  sfSymbol: "envelope.fill",
  color: "#5865F2",
  bgColor: "#171A2B",
  imageDataUri: svgDataUri(tintLucideSvg(MAIL_SVG, "#5865F2")),
};

const fastmailIcon: SourceIcon = {
  sfSymbol: "envelope.fill",
  color: "#3B82F6",
  bgColor: "#10233D",
  url: "https://www.fastmail.com/apple-touch-icon.png",
};

const iCloudMailIcon: SourceIcon = {
  sfSymbol: "icloud.fill",
  color: "#0A84FF",
  bgColor: "#10243A",
  imageDataUri: svgDataUri(tintLucideSvg(CLOUD_SVG, "#0A84FF")),
};

const HOST_ICONS: Record<string, SourceIcon> = {
  "imap.fastmail.com": fastmailIcon,
  "imap.mail.me.com": iCloudMailIcon,
};

export function imapIconForHost(host: string): SourceIcon {
  return HOST_ICONS[host.trim().toLowerCase().replace(/\.$/, "")] ?? genericImapIcon;
}
