// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The `android-call-log` source's glyph — a Lucide phone-call SVG
 * (MIT-licensed, the same glyph `apple-call-log` uses) tinted Android green,
 * embedded as a data URI so the portal's strict CSP
 * (`img-src 'self' data: blob:`) lets it through.
 *
 * The real source (Android, Kotlin) owns its own copy of this exact
 * construction in `CallLogIcon.kt`; the output must stay byte-identical so
 * the portal shows a single stable icon for the source no matter which side
 * registered it.
 */

function tintLucideSvg(svg: string, color: string): string {
  return svg.replace(/stroke="currentColor"/g, `stroke="${color}"`);
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const PHONE_CALL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2a9 9 0 0 1 9 9"/><path d="M13 6a5 5 0 0 1 5 5"/><path d="M14.05 2a13 13 0 0 1 8 8"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;

/** Android green (#3DDC84). */
export const androidCallLogIconDataUri = svgDataUri(tintLucideSvg(PHONE_CALL_SVG, "#3DDC84"));
