// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The OAuth addresses for the request being answered. A request from software
 * on the gateway's own machine signs in at the loopback address it dialled even
 * when the gateway has a public address; that is decided from the connection,
 * never from the Host header, which a proxy, the relay or Tailscale pass on as
 * the client sent it.
 */

import { resolveOAuthUrls, type OAuthIssuerSource } from "../access/oauth-urls.js";
import { FUNNEL_REQUEST_HEADER } from "../remote-access/host-access.js";
import { tailnetCallerOfEnv } from "../tailscale-embed/caller.js";
import { arrivedThroughRelay, isLoopbackClient } from "./client-ip.js";
import type { Context } from "hono";
import type { AppEnv } from "./routes/types.js";

/**
 * Whether a request came from the gateway's own machine: over loopback, with no
 * proxy on it reporting another client, and not through Tailscale Funnel, the
 * relay or the gateway's own tailnet device.
 */
export function isLocalRequest(c: Context<AppEnv>): boolean {
  const header = (name: string) => c.req.header(name);
  return (
    isLoopbackClient(header, c.env) &&
    header(FUNNEL_REQUEST_HEADER) === undefined &&
    tailnetCallerOfEnv(c.env) === null &&
    !arrivedThroughRelay(header, c.env)
  );
}

/** `resolveOAuthUrls` for the request `c` is answering. */
export function resolveRequestOAuthUrls(
  c: Context<AppEnv>,
  configuredBaseUrl?: string,
  configuredResources?: readonly string[],
  issuers?: OAuthIssuerSource,
) {
  return resolveOAuthUrls(c.req.url, configuredBaseUrl, configuredResources, issuers, {
    local: isLocalRequest(c),
  });
}
