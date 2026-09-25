// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Provider glyphs are fetched and cached by the gateway, then served same-origin. */

import { html } from "htm/preact";
import { PORTAL_PROVIDER_BRANDS } from "./provider-brands-data.js";

export { PORTAL_PROVIDER_BRANDS };

/** Look up a brand by id; the `none` entry if unknown so callers never get undefined. */
export function providerBrand(id) {
  return PORTAL_PROVIDER_BRANDS[id] ?? PORTAL_PROVIDER_BRANDS.none;
}

const WITHOUT_LOGO = new Set(["local", "replay", "http", "none"]);

/** A provider SVG served by this gateway as a theme-colored mask. */
export function ProviderIcon({ providerId, size }) {
  if (!providerId || WITHOUT_LOGO.has(providerId)) return null;
  const brand = providerBrand(providerId);
  const dim = size == null ? null : typeof size === "number" ? `${size}px` : size;
  // encodeURIComponent leaves punctuation that could end a CSS url() token.
  const slug = encodeURIComponent(providerId).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const url = `/model-logos/${slug}.svg`;
  const label = brand.id === "none" ? providerId : brand.label;
  return html`<span
    class="provider-icon"
    style=${[`--provider-icon-url:url("${url}")`, ...(dim ? [`width:${dim}`, `height:${dim}`] : [])].join(";")}
    role="img"
    aria-label=${label}
    title=${label}
  ></span>`;
}
