// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The one place the owner's choices about addresses away from home are
 * enforced: a request for an MCP client's path that reached the gateway by an
 * address whose MCP does not answer it, and a request Tailscale on this
 * computer forwarded from the Internet for what the owner keeps off it, get
 * the gateway's ordinary 404 before any route runs. See
 * `remote-access/mcp-addresses.ts` and `remote-access/host-access.ts` for
 * which requests those are.
 *
 * The one exception is an agent the owner connected at that address: a request
 * to `/mcp` carrying a valid token for that address's own MCP resource is told
 * that MCP is off there (`mcp/address-off-server.ts`) instead of finding
 * nothing, and still reaches no tool. Without such a token — none, an invalid
 * one, or one for another address — the answer stays the 404, so to anyone
 * else an address that is off still looks like one without MCP.
 */

import { createLogger } from "@omnesis/core";
import { tailnetCallerOfEnv } from "../tailscale-embed/caller.js";
import { FUNNEL_REQUEST_HEADER } from "../remote-access/host-access.js";
import {
  isMcpClientPath,
  type McpAddresses,
  type McpRefusal,
} from "../remote-access/mcp-addresses.js";
import { createMcpAddressOffHandler } from "../mcp/address-off-server.js";
import { arrivedThroughRelay, arrivedThroughRelayTunnel, fromHomeNetwork } from "./client-ip.js";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./routes/types.js";

const log = createLogger("gateway:http:mcp-address");

/** Whether `rawToken` is a valid OAuth access token issued for exactly `resource`. */
export type McpTokenCheck = (rawToken: string, resource: string) => boolean;

export function mcpAddressGate(
  addresses: Pick<McpAddresses, "refusal" | "resourceAt">,
  tokenValidFor?: McpTokenCheck,
): MiddlewareHandler<AppEnv> {
  const turnedOff = tokenValidFor ? createMcpAddressOffHandler() : null;
  return async (c, next) => {
    const refused = await addresses.refusal({
      url: c.req.url,
      path: c.req.path,
      via: tailnetCallerOfEnv(c.env)?.via ?? null,
      // The tunnel's own socket, never a header: being relayed exempts a request from the
      // Funnel check, so a client must not be able to claim it.
      relayed: arrivedThroughRelayTunnel(c.env),
      funnel: c.req.header(FUNNEL_REQUEST_HEADER) === "?1",
    });
    if (!refused) return next();
    if (turnedOff && tokenValidFor && connectedAgent(c, refused, addresses, tokenValidFor)) {
      log.info(
        `${c.req.method} /mcp from an agent connected at the ${refused} address: told MCP is off there`,
      );
      return privateResponse(await turnedOff.fetch(c.req.raw));
    }
    log.debug(
      refused === "host-internet-api"
        ? `${c.req.method} ${c.req.path} not served: kept off the Internet on this computer's Tailscale address`
        : `${c.req.method} ${c.req.path} not served: MCP does not answer it on the ${refused} address`,
    );
    return c.notFound();
  };
}

/**
 * Whether a refused request is an MCP call from an agent the owner connected at the address
 * that refused it: `/mcp` itself, not from a browser page (which the endpoint never serves),
 * with a bearer token valid for that address's own MCP resource.
 */
function connectedAgent(
  c: Context<AppEnv>,
  refused: McpRefusal,
  addresses: Pick<McpAddresses, "resourceAt">,
  tokenValidFor: McpTokenCheck,
): boolean {
  if (refused === "host-internet-api" || c.req.path !== "/mcp") return false;
  if (c.req.header("Origin") !== undefined) return false;
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const resource = addresses.resourceAt(refused);
  return resource !== null && tokenValidFor(authorization.slice(7), resource);
}

/** The MCP endpoint's own caching rules: an answer for one token is never stored or shared. */
function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Vary", "Authorization, Origin");
  headers.delete("Mcp-Session-Id");
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Marks a request for an MCP client's path that may sign in through the
 * home-network address it used (`McpAddresses.homeSignIn`), which the OAuth
 * routes and the MCP endpoint read through `resolveRequestOAuthUrls`. Being
 * relayed is taken from the tunnel's socket or the relay's header: either one
 * withholds the home-network address.
 */
export function homeSignInMiddleware(
  addresses: Pick<McpAddresses, "homeSignIn">,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (isMcpClientPath(c.req.path)) {
      const header = (name: string) => c.req.header(name);
      c.set(
        "homeSignIn",
        await addresses.homeSignIn({
          url: c.req.url,
          via: tailnetCallerOfEnv(c.env)?.via ?? null,
          relayed: arrivedThroughRelay(header, c.env),
          funnel: header(FUNNEL_REQUEST_HEADER) !== undefined,
          fromHomeNetwork: fromHomeNetwork(header, c.env),
        }),
      );
    }
    return next();
  };
}
