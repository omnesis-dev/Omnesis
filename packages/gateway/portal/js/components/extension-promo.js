// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Browser-extension promo — the card on the Sources page that advertises the
// Omnesis Browser Capture extension. It shows only when the gateway has no
// `web` source (no browser has delivered a page, i.e. the extension is not
// currently paired) and the portal is open in a desktop Chromium-based
// browser that can install Chrome Web Store extensions. The card has no
// dismiss affordance: it stays until a page delivery creates the source.

import { html } from "htm/preact";
import { navigate } from "../lib/router.js";
import { PromoCard } from "./promo-card.js";
import { sourceTypeOf } from "../lib/source-id.js";
import { CHROME_WEB_STORE_URL, EXTENSION_PAIR_PATH, CHROME_LOGO_URL } from "../lib/extension-links.js";

/**
 * True for desktop Chromium-based browsers (Chrome, Edge, Brave, Arc, …) —
 * anything that installs Chrome Web Store extensions. Mobile browsers are
 * excluded: their UAs carry a Chrome token but they cannot install store
 * extensions. Prefers `userAgentData.brands` where available, falls back to
 * the user-agent string.
 */
export function isChromiumBrowser({ userAgent = "", brands = [], mobile = false } = {}) {
  if (mobile || /Mobile|Android/i.test(userAgent)) return false;
  if (Array.isArray(brands) && brands.some((b) => /chrom/i.test(b?.brand ?? ""))) return true;
  return (
    /Chrome|Chromium/i.test(userAgent) && !/Firefox|FxiOS/i.test(userAgent)
  );
}

function browserSignals() {
  const nav = globalThis.navigator ?? {};
  return {
    userAgent: typeof nav.userAgent === "string" ? nav.userAgent : "",
    brands: Array.isArray(nav.userAgentData?.brands) ? nav.userAgentData.brands : [],
    mobile: nav.userAgentData?.mobile ?? false,
  };
}

/**
 * Whether any known source is the extension-fed `web` source. Ids can be
 * scoped (`web:…`), so the match is on the id prefix — the same rule the
 * collector's browser-capture suite uses.
 */
export function hasWebSource(sources) {
  if (!Array.isArray(sources)) return false;
  return sources.some((s) => (s?.type || sourceTypeOf(s?.id)) === "web");
}

export function shouldShowExtensionPromo({ sources, userAgent, brands, mobile } = {}) {
  if (hasWebSource(sources)) return false;
  if (userAgent === undefined && brands === undefined && mobile === undefined) {
    return isChromiumBrowser(browserSignals());
  }
  return isChromiumBrowser({
    userAgent: userAgent ?? "",
    brands: brands ?? [],
    mobile: mobile ?? false,
  });
}

export function ExtensionPromoCard() {
  return html`
    <${PromoCard}
      className="extension-promo"
      label="Install the browser extension"
      logoUrl=${CHROME_LOGO_URL}
      title="Install the Chrome extension"
      tagline="Ingests and indexes the web pages you read."
    >
      <p>
        The Omnesis Browser Capture extension ingests and indexes the web pages
        you read, so they are searchable alongside the rest of your data.
        Install it from the Chrome Web Store, then pair it with this gateway.
      </p>
      <div class="promo-modal-actions">
        <a
          class="btn-primary ext-promo-install"
          href=${CHROME_WEB_STORE_URL}
          target="_blank"
          rel="noreferrer noopener"
        >Install from the Chrome Web Store</a>
        <a
          class="ext-promo-pair"
          href=${EXTENSION_PAIR_PATH}
          onClick=${(e) => {
            e.preventDefault();
            navigate(EXTENSION_PAIR_PATH);
          }}
        >Already installed? Pair it</a>
      </div>
    </${PromoCard}>
  `;
}
