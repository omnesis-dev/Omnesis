// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";

import { liveGatewayHolder, type GatewayLockHolder } from "./gateway-lock.js";
import { certificateCoversHost, resolveTlsMaterial } from "./tls-material.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Whether the certificate a gateway using `configDir` serves names `localhost`.
 *
 * The gateway serves one certificate: the `OMNESIS_TLS_CERT`/`OMNESIS_TLS_KEY`
 * pair when both are set (a provisioned tailnet or mkcert certificate, or the
 * operator's own), else the self-signed one it mints under `<configDir>/tls`,
 * which always names localhost — so a self-signed certificate not minted yet
 * counts. Any other certificate that cannot be read does not.
 */
export function servedCertificateCoversLocalhost(
  configDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const material = resolveTlsMaterial({
    configDir,
    certPath: env.OMNESIS_TLS_CERT,
    keyPath: env.OMNESIS_TLS_KEY,
  });
  if (material.ownership === "self-signed" && !existsSync(material.certPath)) return true;
  try {
    return certificateCoversHost(new X509Certificate(readFileSync(material.certPath)), "localhost");
  } catch {
    return false;
  }
}

/**
 * Where a client on this machine should send requests for `gatewayUrl`.
 *
 * An install records the address other machines use to reach the gateway
 * (`omnesis.local`, a LAN name) in `OMNESIS_GATEWAY_URL`, which clients on
 * the gateway's own machine load too. That name may not resolve here: a stock
 * Linux server resolves no `.local` name, and macOS denies Homebrew's node
 * local network access, so every `.local` lookup fails. When a live gateway on
 * this host holds `configDir`, it is the gateway that URL names, and loopback
 * reaches it on the same port — provided the certificate it serves names
 * localhost; a tailnet or operator certificate naming only its own host is
 * reached by that name. A URL with no explicit port or with a path names
 * something in front of the gateway (a reverse proxy), not its listener.
 * Those, a URL that already names loopback, a gateway elsewhere, and an
 * unparseable value are returned unchanged.
 */
export function localGatewayRequestUrl(
  gatewayUrl: string,
  configDir: string,
  holder: (configDir: string) => GatewayLockHolder | null = liveGatewayHolder,
  coversLocalhost: (configDir: string) => boolean = servedCertificateCoversLocalhost,
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
  if (!coversLocalhost(configDir)) return gatewayUrl;
  return `${url.protocol}//localhost:${url.port}`;
}
