// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The `health-connect` source owns its own glyph — a Lucide heart-pulse SVG
 * (MIT-licensed) tinted Android green, embedded as a data URI so the portal's
 * strict CSP (`img-src 'self' data: blob:`) lets it through. We don't reuse
 * Google's first-party Health Connect mark.
 */

function tintLucideSvg(svg: string, color: string): string {
  return svg.replace(/stroke="currentColor"/g, `stroke="${color}"`);
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const HEART_PULSE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/></svg>`;

/** Android green (#3DDC84). */
export const healthConnectIconDataUri = svgDataUri(tintLucideSvg(HEART_PULSE_SVG, "#3DDC84"));
