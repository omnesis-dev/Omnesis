// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Apple's brand guidelines explicitly forbid third-party use of their
 * first-party app icons in other software UIs (Notes, Reminders, Messages,
 * Contacts). To stay safe in an open-source repo, this package owns its
 * own glyphs — Lucide SVGs (ISC-licensed, see `TRADEMARKS.md`) tinted to
 * the Apple-app accent color. They're embedded as data URIs so each
 * source's manifest is fully self-contained.
 */

/** Tint a Lucide stroke SVG by replacing `currentColor` with a hex color. */
function tintLucideSvg(svg: string, color: string): string {
  return svg.replace(/stroke="currentColor"/g, `stroke="${color}"`);
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

// ── Lucide source SVGs (ISC-licensed, copied from lucide-static) ──────

const NOTEBOOK_PEN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/></svg>`;

const LIST_CHECKS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/></svg>`;

const MESSAGE_SQUARE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/></svg>`;

const CONTACT_ROUND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 2v2"/><path d="M17.915 22a6 6 0 0 0-12 0"/><path d="M8 2v2"/><circle cx="12" cy="12" r="4"/><rect x="3" y="4" width="18" height="18" rx="2"/></svg>`;

const CALENDAR_DAYS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/></svg>`;

const PHONE_CALL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2a9 9 0 0 1 9 9"/><path d="M13 6a5 5 0 0 1 5 5"/><path d="M14.05 2a13 13 0 0 1 8 8"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;

const VOICEMAIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="12" r="4"/><circle cx="18" cy="12" r="4"/><path d="M6 16h12"/></svg>`;

// ── Apple-tinted exports ──────────────────────────────────────────────

export const appleNotesIconDataUri = svgDataUri(tintLucideSvg(NOTEBOOK_PEN_SVG, "#FFCC00"));
export const appleRemindersIconDataUri = svgDataUri(tintLucideSvg(LIST_CHECKS_SVG, "#FF9500"));
export const appleIMessageIconDataUri = svgDataUri(tintLucideSvg(MESSAGE_SQUARE_SVG, "#34C759"));
export const appleContactsIconDataUri = svgDataUri(tintLucideSvg(CONTACT_ROUND_SVG, "#FF6B6B"));
export const appleCalendarIconDataUri = svgDataUri(tintLucideSvg(CALENDAR_DAYS_SVG, "#FF3B30"));
export const appleCallLogIconDataUri = svgDataUri(tintLucideSvg(PHONE_CALL_SVG, "#30D158"));
export const appleVoicemailIconDataUri = svgDataUri(tintLucideSvg(VOICEMAIL_SVG, "#30D158"));
