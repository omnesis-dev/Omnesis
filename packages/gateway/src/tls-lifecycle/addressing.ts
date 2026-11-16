// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Where the served material lives right now, and which names the gateway is
 * addressed by — the two inputs the lifecycle re-reads on every tick rather
 * than freezing at boot.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseDotEnv } from "@omnesis/config";
import { normalizeRequiredHost } from "@omnesis/core";

/**
 * `OMNESIS_TLS_CERT` / `OMNESIS_TLS_KEY`, and the private CA behind them
 * (`OMNESIS_TLS_CA`), as the config directory's `.env` spells them now,
 * falling back to what the process was started with — except for a key `.env`
 * itself supplied at boot and has since dropped, which reads as unset. A
 * provisioning run that rewrote the file is picked up without a restart, and
 * so is one that took the override away.
 */
export function currentTlsMaterialPaths(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
  suppliedByDotEnvAtBoot: ReadonlySet<string> = new Set(),
): { certPath?: string; keyPath?: string; caPath?: string } {
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseDotEnv(readFileSync(join(configDir, ".env"), "utf8"));
  } catch {
    // No .env, or unreadable: the boot-time environment stands.
  }
  const current = (
    key: "OMNESIS_TLS_CERT" | "OMNESIS_TLS_KEY" | "OMNESIS_TLS_CA",
  ): string | undefined =>
    fromFile[key] ?? (suppliedByDotEnvAtBoot.has(key) ? undefined : env[key]);
  const certPath = current("OMNESIS_TLS_CERT");
  const keyPath = current("OMNESIS_TLS_KEY");
  const caPath = current("OMNESIS_TLS_CA");
  return {
    ...(certPath ? { certPath } : {}),
    ...(keyPath ? { keyPath } : {}),
    ...(caPath ? { caPath } : {}),
  };
}

/**
 * The hostnames and IP literals clients reach this gateway by: whatever the
 * given URLs and origins name. Malformed entries are skipped; duplicates
 * collapse.
 */
export function addressedGatewayHosts(urls: ReadonlyArray<string | null | undefined>): string[] {
  const hosts = new Set<string>();
  for (const value of urls) {
    if (!value) continue;
    try {
      const host = normalizeRequiredHost(new URL(value).hostname);
      if (host) hosts.add(host);
    } catch {
      // Not a URL: nothing to cover.
    }
  }
  return [...hosts];
}

/** The port a URL is reached at, its scheme's default when it names none; null when malformed. */
function urlPort(value: string | null | undefined): number | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.port) return Number(url.port);
    return url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : null;
  } catch {
    return null;
  }
}

/**
 * Which of the names the gateway is addressed by its own certificate must
 * cover, and which a reverse proxy covers instead. Clients verify a proxied
 * name against the proxy's certificate; the gateway's own is seen only on the
 * hop from the proxy.
 *
 * With `OMNESIS_TRUST_PROXY` (a proxy on another machine), the public base
 * URL and the system-trust pairing origins are the proxy's, and a gateway URL
 * naming anything else is still the gateway's. The flag is taken at its word:
 * set without a proxy in front, the public name stops being checked here and
 * clients find the gap by failing hostname verification.
 *
 * Without it, an address at a port other than the one the gateway listens on
 * reaches it only through something in front of it — a proxy on this machine
 * such as Caddy, nginx or Tailscale Serve — so its name is the proxy's,
 * unless the same name is also addressed at the gateway's own port. A router
 * forwarding another port straight to the gateway is the one setup this reads
 * wrongly: its public name goes unchecked, as with the flag.
 */
export function partitionAddressedHosts(input: {
  gatewayUrl: string | null | undefined;
  publicBaseUrl: string | null | undefined;
  trustOrigins: ReadonlyArray<string | null | undefined>;
  proxyTrusted: boolean;
  /** The port the gateway itself listens on. */
  gatewayPort: number;
}): { required: string[]; proxied: string[] } {
  const published = [input.publicBaseUrl, ...input.trustOrigins];
  const all = addressedGatewayHosts([input.gatewayUrl, ...published]);
  let proxied: Set<string>;
  if (input.proxyTrusted) {
    proxied = new Set(addressedGatewayHosts(published));
  } else {
    const own = new Set(
      addressedGatewayHosts([
        input.gatewayUrl,
        ...published.filter((url) => urlPort(url) === input.gatewayPort),
      ]),
    );
    proxied = new Set(
      addressedGatewayHosts(
        published.filter((url) => {
          const port = urlPort(url);
          return port !== null && port !== input.gatewayPort;
        }),
      ).filter((host) => !own.has(host)),
    );
  }
  return {
    required: all.filter((host) => !proxied.has(host)),
    proxied: [...proxied],
  };
}
