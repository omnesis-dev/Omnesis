// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Resvg } from "@resvg/resvg-js";

const SVG_TEXT_ELEMENT = /<(?:[\w.-]+:)?text[\s>/]/;

/**
 * Render an SVG icon to a base64 PNG, `targetSize` pixels wide.
 *
 * Resvg reads every font installed on the machine for each render unless told
 * not to. That dominates the render: 0.1 ms for a brand glyph without the fonts,
 * tens of milliseconds with them, and far more on a Mac, which has hundreds of
 * fonts, or on a slow disk. Only `<text>` needs a font, so only an icon that has
 * one pays for them.
 */
export function rasterizeSvgToPngBase64(svgBytes: Buffer, targetSize: number): string {
  const resvg = new Resvg(svgBytes, {
    fitTo: { mode: "width", value: targetSize },
    background: "rgba(0,0,0,0)",
    font: { loadSystemFonts: SVG_TEXT_ELEMENT.test(svgBytes.toString("latin1")) },
  });
  return Buffer.from(resvg.render().asPng()).toString("base64");
}
