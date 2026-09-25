// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Canonical links for the Omnesis iOS app: the TestFlight invite the
// Sources promo card points at, and the Devices-tab deep link that opens
// the pairing modal with the iOS kind preselected (see `pair` in
// parseRoute and `resolvePairKindRequest` in views/devices.js).

export const TESTFLIGHT_URL = "https://testflight.apple.com/join/KpMV6HTy";

export const IOS_PAIR_PATH = "/portal/settings/devices?pair=ios";

// Product mark for the promo card, vendored under portal/img/ (sourced from
// Wikimedia Commons). Same-origin for the same CSP reason as CHROME_LOGO_URL
// in lib/extension-links.js.
export const APPLE_LOGO_URL = "/portal/img/apple-logo.svg";
