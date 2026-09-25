// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Canonical links for the Omnesis Android app. The app is in closed testing
// on Google Play: a tester joins the Google Group first, then opts in with
// the same Google account; the opt-in page links on to the Play listing.
// ANDROID_PAIR_PATH is the Devices-tab deep link that opens the pairing modal
// with the Android kind preselected (see `pair` in parseRoute and
// `resolvePairKindRequest` in views/devices.js).

export const ANDROID_TESTER_GROUP_URL = "https://groups.google.com/g/omnesis-alpha-testers";

export const ANDROID_OPT_IN_URL = "https://play.google.com/apps/testing/dev.omnesis.android";

export const ANDROID_PAIR_PATH = "/portal/settings/devices?pair=android";

// Product mark for the promo card, vendored under portal/img/ (the Simple
// Icons Android glyph, CC0). Same-origin for the same CSP reason as
// CHROME_LOGO_URL in lib/extension-links.js.
export const ANDROID_LOGO_URL = "/portal/img/android-logo.svg";
