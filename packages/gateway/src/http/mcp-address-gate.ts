// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The one place an address with MCP turned off is enforced: a request
 * for an MCP client's path that reached the gateway by such an address gets
 * the gateway's ordinary 404, before authentication or any route runs. See
 * `remote-access/mcp-addresses.ts` for which requests that is.
 */

import { createLogger } from "@omnesis/core";
import { tailnetCallerOfEnv } from "../tailscale-embed/caller.js";
import { arrivedThroughRelay } from "./client-ip.js";
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
      relayed: arrivedThroughRelay((name) => c.req.header(name), c.env),
    });
    if (!refused) return next();
    log.debug(`${c.req.method} ${c.req.path} not served: MCP is off on the ${refused} address`);
    return c.notFound();
  };
}
