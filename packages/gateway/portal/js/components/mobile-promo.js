// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Visibility rule shared by the phone-app promo cards on the Sources page
// (iOS and Android). Both show only while the gateway has no mobile-pushed
// source (no phone has ever synced: no Apple Health from iOS, no Health
// Connect / photos / app-usage / call-log / activity-segments from Android).
// Any mobile source hides both — a user with either phone paired is assumed
// not to want a nudge for the other. Unlike the browser-extension promo there
// is no browser gate: the install links open anywhere. The cards have no
// dismiss affordance: they stay until a phone push creates a mobile source.

import { sourceTypeOf } from "../lib/source-id.js";

// Source types only a phone ever pushes. `photos` is shared by both phone
// apps (no desktop source uses that type). Keep in sync with the Android
// SOURCE_TYPE constants and the iOS *Source.swift files
// (AppleHealth, CoreLocationVisits, ActivitySegments, Photos).
const MOBILE_SOURCE_TYPES = new Set([
  // iOS app.
  "apple-health",
  "core-location-visits",
  "activity-segments",
  // Android app (`photos` is pushed by both).
  "photos",
  "health-connect",
  "android-app-usage",
  "android-call-log",
  "android-activity-segments",
]);

/**
 * Whether any known source was pushed by a mobile app (iOS or Android).
 * Prefers the row's `type`, falls back to the id prefix — the same rule
 * the extension promo's `hasWebSource` uses for `web`.
 */
export function hasMobileSource(sources) {
  if (!Array.isArray(sources)) return false;
  return sources.some((s) => MOBILE_SOURCE_TYPES.has(s?.type || sourceTypeOf(s?.id)));
}

export function shouldShowMobilePromos({ sources } = {}) {
  return !hasMobileSource(sources);
}
