// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// iOS-app promo — the card on the Sources page that advertises the Omnesis
// iPhone app. When it shows is decided by `shouldShowMobilePromos` in
// mobile-promo.js, shared with the Android card.

import { html } from "htm/preact";
import { navigate } from "../lib/router.js";
import { PromoCard } from "./promo-card.js";
import { TESTFLIGHT_URL, IOS_PAIR_PATH, APPLE_LOGO_URL } from "../lib/ios-links.js";

export function IosPromoCard() {
  return html`
    <${PromoCard}
      className="ios-promo"
      label="Install the iOS app"
      logoUrl=${APPLE_LOGO_URL}
      logoClass="ext-promo-logo-apple"
      title="Get the iPhone app"
      tagline="Syncs Apple Health, location visits, and more."
    >
      <p>
        The Omnesis iOS app syncs Apple Health, location visits, and more.
        It is currently in external testing on TestFlight (limited
        to 10,000 testers) while we work on publishing it in the App Store.
      </p>
      <div class="promo-modal-actions">
        <a
          class="btn-primary ios-promo-install"
          href=${TESTFLIGHT_URL}
          target="_blank"
          rel="noreferrer noopener"
        >Install via TestFlight</a>
        <a
          class="ext-promo-pair ios-promo-pair"
          href=${IOS_PAIR_PATH}
          onClick=${(e) => {
            e.preventDefault();
            navigate(IOS_PAIR_PATH);
          }}
        >Already have it? Pair it</a>
      </div>
    </${PromoCard}>
  `;
}
