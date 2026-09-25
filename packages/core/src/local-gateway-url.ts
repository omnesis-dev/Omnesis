// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { X509Certificate } from "node:crypto";
import dns from "node:dns";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";

import { liveGatewayHolder, type GatewayLockHolder } from "./gateway-lock.js";
import { certificateCoversHost, resolveTlsMaterial } from "./tls-material.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Whether the certificate a gateway using `configDir` serves names `host`.
 *
 * The gateway serves one certificate: the `OMNESIS_TLS_CERT`/`OMNESIS_TLS_KEY`
 * pair when both are set (a provisioned tailnet or mkcert certificate, or the
 * operator's own), else the self-signed one it mints under `<configDir>/tls`,
 * which always names localhost — so for localhost a self-signed certificate
 * not minted yet counts. Any other certificate that cannot be read does not.
 */
export function servedCertificateCoversHost(
  configDir: string,
  host: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const material = resolveTlsMaterial({
    configDir,
    certPath: env.OMNESIS_TLS_CERT,
    keyPath: env.OMNESIS_TLS_KEY,
  });
  if (material.ownership === "self-signed" && !existsSync(material.certPath)) {
    return host === "localhost";
  }
  try {
    return certificateCoversHost(new X509Certificate(readFileSync(material.certPath)), host);
  } catch {
    return false;
  }
}

/** Whether the certificate a gateway using `configDir` serves names `localhost`. */
export function servedCertificateCoversLocalhost(
  configDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return servedCertificateCoversHost(configDir, "localhost", env);
}

/** Host names this process resolves to loopback, whatever DNS says. */
const loopbackNames = new Set<string>();

/**
 * Resolve `host` to this machine's loopback address for every later
 * connection this process opens — `fetch`, the `WebSocket` global, `ws`,
 * raw `node:tls` all resolve through `dns.lookup`. Only the address changes:
 * the connection still sends `host` as its TLS server name and verifies the
 * certificate against it, exactly as `/etc/hosts` mapping it would.
 */
export function resolveHostToLoopback(host: string): void {
  if (loopbackNames.size === 0) {
    const lookup = dns.lookup;
    const pinned = function (this: unknown, hostname: unknown, ...rest: unknown[]): unknown {
      const name =
        typeof hostname === "string" && loopbackNames.has(hostname.toLowerCase())
          ? "localhost"
          : hostname;
      return Reflect.apply(lookup, this, [name, ...rest]);
    };
    // Keep `util.promisify(dns.lookup)` behaving as before.
    for (const key of Reflect.ownKeys(lookup)) {
      if (!Object.prototype.hasOwnProperty.call(pinned, key)) {
        Object.defineProperty(pinned, key, Object.getOwnPropertyDescriptor(lookup, key)!);
      }
    }
    dns.lookup = pinned as typeof dns.lookup;
  }
  loopbackNames.add(host.toLowerCase());
}

/** Whether `host` names loopback, literally or by `resolveHostToLoopback`. */
export function resolvesToLoopback(host: string): boolean {
  const name = host.toLowerCase();
  return LOOPBACK_HOSTS.has(name) || loopbackNames.has(name);
}

/**
 * Where a client on this machine should send requests for `gatewayUrl`.
 *
 * An install records the address other machines use to reach the gateway
 * (`omnesis.local`, a LAN name, a tailnet name) in `OMNESIS_GATEWAY_URL`,
 * which clients on the gateway's own machine load too. That name may not
 * resolve here: a stock Linux server resolves no `.local` name, macOS denies
 * Homebrew's node local network access, so every `.local` lookup fails, and a
 * tailnet name stops resolving while Tailscale is down. When a live gateway on
 * this host holds `configDir`, it is the gateway that URL names, and loopback
 * reaches it on the same port. If the certificate it serves names localhost,
 * the returned URL names localhost. If it names only the recorded host (a
 * tailnet or operator certificate), the URL is returned unchanged and that
 * host is resolved to loopback in this process, so the certificate is still
 * verified against the name it was issued for. A URL with no explicit port or
 * with a path names something in front of the gateway (a reverse proxy), not
 * its listener. Those, a URL that already names loopback, a gateway elsewhere,
 * and an unparseable value are returned unchanged.
 */
export function localGatewayRequestUrl(
  gatewayUrl: string,
  configDir: string,
  holder: (configDir: string) => GatewayLockHolder | null = liveGatewayHolder,
  covers: (configDir: string, host: string) => boolean = servedCertificateCoversHost,
  toLoopback: (host: string) => void = resolveHostToLoopback,
): string {
  let url: URL;
  try {
    url = new URL(gatewayUrl);
  } catch {
    return gatewayUrl;
  }
  if (LOOPBACK_HOSTS.has(url.hostname)) return gatewayUrl;
  if (!url.port || url.pathname.replace(/\/+$/, "") !== "") return gatewayUrl;
  const live = holder(configDir);
  if (!live || live.hostname !== hostname()) return gatewayUrl;
  if (covers(configDir, "localhost")) return `${url.protocol}//localhost:${url.port}`;
  if (url.protocol === "https:" && covers(configDir, url.hostname)) toLoopback(url.hostname);
  return gatewayUrl;
}
