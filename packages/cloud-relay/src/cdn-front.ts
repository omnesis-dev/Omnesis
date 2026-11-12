// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { createLogger } from "@omnesis/core";
import { relayOrigin } from "./network.js";
import { connectionClientAddress, ProxyProtocolPeers } from "./proxy-protocol.js";

/**
 * A TLS-terminating reverse proxy (a CDN) in front of the control listener.
 *
 * Such a proxy opens the connection, so the connection's address is the proxy's.
 * It names the client it serves in a request header, which anyone can also send.
 * The header is therefore read only on requests whose connection comes from the
 * operator's list of proxy ranges, where "comes from" is the address a trusted
 * PROXY protocol front layer reported, otherwise the TCP peer. Everyone else's
 * header is ignored and their connection address stands. The address feeds rate
 * limits only, never authorization.
 */

const log = createLogger("cloud-relay:cdn");

/** The header Cloudflare sets, and overwrites when a client sends its own. */
export const DEFAULT_CLIENT_ADDRESS_HEADER = "cf-connecting-ip";
const RELOAD_MS = 5 * 60_000;

export interface TrustedProxies {
  has(address: string | undefined): boolean;
  /** Stops watching a file of ranges. */
  close?(): void;
}

export interface CdnFront {
  /** The proxy's own addresses: the only connections whose client address header is read. */
  proxies: TrustedProxies;
  clientAddressHeader: string;
  /**
   * A hostname for the same control listener that does not go through the proxy. A gateway
   * that reaches the tunnel through the proxy and says it can move is sent there, so the
   * encrypted streams it carries never cross the proxy.
   */
  tunnelOrigin?: string;
  /**
   * What a connection that did not come through the proxy may use: everything, or only the
   * gateway tunnel and the health check, once the pages and APIs are served through the proxy.
   */
  directRoutes?: "all" | "tunnel";
}

/** A comma-separated list of proxy addresses and CIDR ranges; an empty list is a mistake. */
export function parseTrustedProxies(value: string): TrustedProxies {
  try {
    return ProxyProtocolPeers.parse(value)!;
  } catch {
    throw new Error("Invalid trusted proxy list; use IP addresses or CIDR ranges");
  }
}

/** One address or range per line; blank lines and `#` comments are skipped. */
function readTrustedProxies(file: string): TrustedProxies {
  const entries = readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.split("#")[0]!.trim())
    .filter(Boolean);
  return parseTrustedProxies(entries.join(","));
}

/**
 * The ranges in a file an operator's timer rewrites when the proxy publishes
 * new ones. It is read again every few minutes, so a change needs no restart;
 * a file that became unreadable or invalid keeps the last good list.
 */
export function watchTrustedProxies(file: string, intervalMs = RELOAD_MS): TrustedProxies {
  let current = readTrustedProxies(file);
  const timer = setInterval(() => {
    try {
      current = readTrustedProxies(file);
    } catch {
      log.warn("Trusted proxy list could not be reloaded; keeping the previous one");
    }
  }, intervalMs);
  timer.unref();
  return { has: (address) => current.has(address), close: () => clearInterval(timer) };
}

export function clientAddressHeader(value: string | undefined): string {
  const name = (value ?? DEFAULT_CLIENT_ADDRESS_HEADER).toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new Error("Invalid client address header name");
  return name;
}

/**
 * The relay daemon's reverse-proxy settings. With no proxy ranges there is no
 * proxy: every other setting is then a mistake, never silently ignored.
 */
export function cdnFront(settings: {
  trustedProxies?: string;
  trustedProxiesFile?: string;
  clientAddressHeader?: string;
  tunnelOrigin?: string;
  directRoutes?: "all" | "tunnel";
}): CdnFront | undefined {
  const { trustedProxies, trustedProxiesFile, tunnelOrigin, directRoutes } = settings;
  if (trustedProxies !== undefined && trustedProxiesFile !== undefined)
    throw new Error("Name the trusted proxies as a list or as a file, not both");
  if (trustedProxies === undefined && trustedProxiesFile === undefined) {
    if (settings.clientAddressHeader !== undefined || tunnelOrigin !== undefined || directRoutes)
      throw new Error("Reverse proxy settings require the trusted proxy ranges");
    return undefined;
  }
  const header = clientAddressHeader(settings.clientAddressHeader);
  const origin = tunnelOrigin === undefined ? undefined : relayOrigin(tunnelOrigin).origin;
  return {
    proxies:
      trustedProxiesFile === undefined
        ? parseTrustedProxies(trustedProxies!)
        : watchTrustedProxies(trustedProxiesFile),
    clientAddressHeader: header,
    tunnelOrigin: origin,
    directRoutes,
  };
}

interface ProxiedRequest {
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  socket?: Parameters<typeof connectionClientAddress>[0];
}

const forwarded = new WeakMap<object, string>();

/**
 * Whether the request came through a trusted proxy. When it did and the proxy
 * named one valid client address, that address is recorded for the request.
 * A repeated or malformed header names nobody: the proxy's own address stands,
 * which only makes its clients share a rate-limit bucket.
 */
export function acceptProxiedRequest(
  req: ProxiedRequest,
  front: Pick<CdnFront, "proxies" | "clientAddressHeader">,
): boolean {
  if (!front.proxies.has(connectionClientAddress(req.socket))) return false;
  const sent = req.rawHeaders.filter(
    (name, index) => index % 2 === 0 && name.toLowerCase() === front.clientAddressHeader,
  );
  const value = req.headers[front.clientAddressHeader];
  if (sent.length === 1 && typeof value === "string" && isIP(value.trim()))
    forwarded.set(req, value.trim());
  return true;
}

/** The client a trusted proxy named for this request, if any. */
export function forwardedClientAddress(request: object | undefined): string | undefined {
  return request === undefined ? undefined : forwarded.get(request);
}
