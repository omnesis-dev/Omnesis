// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { RelayError } from "./tunnels.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccountDiscovery } from "./account-discovery.js";

const paths = new Set(["/_relay/v3/gateways", "/_relay/v3/gateway", "/_relay/v3/account-keys"]);

/** Gateway hints and enrollment attestations use explicit bearer credentials, never a browser login cookie. */
export class AccountDiscoveryHttp {
  constructor(private readonly discovery: AccountDiscovery) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url!, "https://relay.invalid");
    if (!paths.has(url.pathname)) return false;
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    if (req.method !== "GET") throw new RelayError(405, "Method not allowed");
    if (req.url!.length > 1024) throw new RelayError(400, "Invalid account discovery request");
    let value: unknown;
    if (url.pathname === "/_relay/v3/account-keys") {
      if (url.search) throw new RelayError(400, "Invalid account key request");
      value = this.discovery.jwks();
    } else {
      const match = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(req.headers.authorization ?? "");
      if (!match) throw new RelayError(401, "Account discovery sign-in required");
      value =
        url.pathname === "/_relay/v3/gateways"
          ? await this.discovery.list(match[1]!, url.searchParams)
          : await this.discovery.select(match[1]!, url.searchParams);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
    return true;
  }
}
