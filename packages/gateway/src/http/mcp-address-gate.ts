// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The one place the owner's choices about addresses away from home are
 * enforced: a request for an MCP client's path that reached the gateway by an
 * address whose MCP does not answer it, and a request Tailscale on this
 * computer forwarded from the Internet for what the owner keeps off it, get
 * the gateway's ordinary 404 before authentication or any route runs. See
 * `remote-access/mcp-addresses.ts` and `remote-access/host-access.ts` for
 * which requests those are.
 */

import { createLogger } from "@omnesis/core";
import { tailnetCallerOfEnv } from "../tailscale-embed/caller.js";
import { FUNNEL_REQUEST_HEADER } from "../remote-access/host-access.js";
import { arrivedThroughRelayTunnel } from "./client-ip.js";
import type { McpAddresses } from "../remote-access/mcp-addresses.js";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./routes/types.js";

const log = createLogger("gateway:http:mcp-address");

export function mcpAddressGate(
  addresses: Pick<McpAddresses, "refusal">,
): MiddlewareHandler<AppEnv> {
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
    log.debug(
      refused === "host-internet-api"
        ? `${c.req.method} ${c.req.path} not served: kept off the Internet on this computer's Tailscale address`
        : `${c.req.method} ${c.req.path} not served: MCP does not answer it on the ${refused} address`,
    );
    return c.notFound();
  };
}
