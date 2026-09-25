// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Canonical links for the Omnesis Browser Capture extension: the store
// listing the Sources promo card and the pairing instructions point at, and
// the Devices-tab deep link that opens the pairing modal with the browser
// kind preselected (see `pair` in parseRoute).

export const CHROME_WEB_STORE_URL =
  "https://chromewebstore.google.com/detail/omnesis-browser-capture/akojepkcdbncipjdonhnnfmjacknplmn";

export const EXTENSION_PAIR_PATH = "/portal/settings/devices?pair=browser";

// Product mark for the promo card, vendored under portal/img/ (sourced from
// Wikimedia Commons) so it loads from the gateway itself: the portal's
// Content-Security-Policy (`img-src 'self' …`) blocks third-party hotlinks,
// and a same-origin file fetches nothing from anyone.
export const CHROME_LOGO_URL = "/portal/img/chrome-logo.svg";
