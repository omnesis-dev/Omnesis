// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon, SourceAttribution } from "@omnesis/source-sdk";

/**
 * Strava's official 192x192 PNG icon, hot-linked from their CloudFront
 * CDN as declared in the strava.com homepage `<link rel="icon">`. See
 * `TRADEMARKS.md` for Strava's API branding requirements.
 */
const stravaIconUrl =
  "https://d3nn82uaxijpm6.cloudfront.net/icon-strava-chrome-192.png?v=dLlWydWlG8";

export const stravaIcon: SourceIcon = {
  sfSymbol: "figure.run",
  color: "#FC4C02",
  bgColor: "#2D170D",
  url: stravaIconUrl,
};

/**
 * Strava's developer guidelines (developers.strava.com/guidelines/) require
 * third-party tools to display a "Powered by Strava" byline alongside any
 * Strava-derived data. The portal/iOS render this generically next to each
 * item from the Strava source — we don't bake the string into the UI.
 */
export const stravaAttribution: SourceAttribution = {
  itemFooter: "Powered by Strava",
};
