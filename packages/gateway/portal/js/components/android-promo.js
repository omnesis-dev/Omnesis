// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Android-app promo — the card on the Sources page that advertises the
// Omnesis Android app, beside the iOS card. When it shows is decided by
// `shouldShowMobilePromos` in mobile-promo.js, shared with the iOS card.

import { html } from "htm/preact";
import { navigate } from "../lib/router.js";
import { PromoCard } from "./promo-card.js";
import {
  ANDROID_TESTER_GROUP_URL,
  ANDROID_OPT_IN_URL,
  ANDROID_PAIR_PATH,
  ANDROID_LOGO_URL,
} from "../lib/android-links.js";

export function AndroidPromoCard() {
  return html`
    <${PromoCard}
      className="android-promo"
      label="Install the Android app"
      logoUrl=${ANDROID_LOGO_URL}
      title="Get the Android app"
      tagline="Syncs Health Connect, photos, app usage, and more."
    >
      <p>
        The Omnesis Android app syncs Health Connect, photos, app usage, and
        more. It is currently in closed testing on Google Play. To install it:
      </p>
      <ol class="promo-modal-steps">
        <li>
          <a
            class="android-promo-join"
            href=${ANDROID_TESTER_GROUP_URL}
            target="_blank"
            rel="noreferrer noopener"
          >Join the tester group</a>.
        </li>
        <li>
          <a
            class="android-promo-opt-in"
            href=${ANDROID_OPT_IN_URL}
            target="_blank"
            rel="noreferrer noopener"
          >Opt in on Google Play</a>${" "}
          with the same Google account.
        </li>
        <li>Install Omnesis from Google Play, then pair it with this gateway.</li>
      </ol>
      <div class="promo-modal-actions">
        <a
          class="ext-promo-pair android-promo-pair"
          href=${ANDROID_PAIR_PATH}
          onClick=${(e) => {
            e.preventDefault();
            navigate(ANDROID_PAIR_PATH);
          }}
        >Already have it? Pair it</a>
      </div>
    </${PromoCard}>
  `;
}
