// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  gatewayBrowserCallback,
  type GatewayBrowserCallbackOrigins,
} from "./gateway-browser-callback.js";
export type GoogleBrowserCallbackOrigins = GatewayBrowserCallbackOrigins;

/** Google handoffs use the same certified gateway-origin policy as account handoffs. */
export function googleBrowserCallback(
  requestOrigin: string,
  path: "/admin/cloud-relay/google/callback" | "/devices/google/callback",
  options: GoogleBrowserCallbackOrigins,
): string {
  return gatewayBrowserCallback(requestOrigin, path, options);
}
