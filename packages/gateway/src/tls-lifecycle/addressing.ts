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
 * `OMNESIS_TLS_CERT` / `OMNESIS_TLS_KEY` as the config directory's `.env`
 * spells them now, falling back to what the process was started with — except
 * for a key `.env` itself supplied at boot and has since dropped, which reads
 * as unset. A provisioning run that rewrote the file is picked up without a
 * restart, and so is one that took the override away.
 */
export function currentTlsMaterialPaths(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
  suppliedByDotEnvAtBoot: ReadonlySet<string> = new Set(),
): { certPath?: string; keyPath?: string } {
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseDotEnv(readFileSync(join(configDir, ".env"), "utf8"));
  } catch {
    // No .env, or unreadable: the boot-time environment stands.
  }
  const current = (key: "OMNESIS_TLS_CERT" | "OMNESIS_TLS_KEY"): string | undefined =>
    fromFile[key] ?? (suppliedByDotEnvAtBoot.has(key) ? undefined : env[key]);
  const certPath = current("OMNESIS_TLS_CERT");
  const keyPath = current("OMNESIS_TLS_KEY");
  return {
    ...(certPath ? { certPath } : {}),
    ...(keyPath ? { keyPath } : {}),
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

/**
 * Which of the names the gateway is addressed by its own certificate must
 * cover, and which a trusted reverse proxy covers instead. Without a proxy
 * every name is the gateway's. With one, the public base URL and the
 * system-trust pairing origins are what the proxy serves: clients verify
 * them against the proxy's certificate, and the gateway's own is seen only
 * on the hop from the proxy. A gateway URL naming anything else is still
 * the gateway's to cover. The flag is taken at its word: set without a proxy
 * in front, the public name stops being checked here and clients find the
 * gap by failing hostname verification.
 */
export function partitionAddressedHosts(input: {
  gatewayUrl: string | null | undefined;
  publicBaseUrl: string | null | undefined;
  trustOrigins: ReadonlyArray<string | null | undefined>;
  proxyTrusted: boolean;
}): { required: string[]; proxied: string[] } {
  const all = addressedGatewayHosts([input.gatewayUrl, input.publicBaseUrl, ...input.trustOrigins]);
  if (!input.proxyTrusted) return { required: all, proxied: [] };
  const proxied = new Set(addressedGatewayHosts([input.publicBaseUrl, ...input.trustOrigins]));
  return {
    required: all.filter((host) => !proxied.has(host)),
    proxied: [...proxied],
  };
}
