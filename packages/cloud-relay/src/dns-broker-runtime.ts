// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { z } from "zod";
import { AcmeDnsChallenges } from "./acme-dns.js";
import { cloudflareDnsProvider } from "./cloudflare-dns.js";
import { createIndependentDnsBroker } from "./independent-dns-server.js";
import { loadRelayRecoveryPolicy } from "./relay-recovery-runtime.js";
import { readPrivateJson } from "./google-credentials.js";
import type { AddressInfo } from "node:net";

const dnsCredentials = [
  "OMNESIS_CLOUD_RELAY_ACME_ZONE_ID",
  "OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME",
  "OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE",
  "OMNESIS_CLOUD_RELAY_ACME_JOURNAL",
] as const;

/** Independent mode keeps DNS mutation credentials out of the exposed relay process. */
export function assertRelayDnsIsolation(env: NodeJS.ProcessEnv): void {
  if (
    (env.OMNESIS_ACME_DNS_PROVIDER === "independent" || env.OMNESIS_ACME_DNS_BROKER_URL) &&
    dnsCredentials.some((name) => env[name] !== undefined)
  )
    throw new Error(
      "Independent DNS mode requires removing DNS credentials from the relay process",
    );
}

const schema = z.object({
  OMNESIS_ACME_DNS_BROKER_URL: z.string().min(1),
  OMNESIS_CLOUD_RELAY_DNS_BROKER_BIND: z.string().default("127.0.0.1"),
  OMNESIS_CLOUD_RELAY_DNS_BROKER_PORT: z.coerce.number().int().min(0).max(65535).default(8789),
  OMNESIS_CLOUD_RELAY_DNS_BROKER_TLS_CERT_FILE: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_DNS_BROKER_TLS_KEY_FILE: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_ACME_ZONE_ID: z.string().min(1),
  OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME: z.string().min(1),
  OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE: z.string().min(1),
  OMNESIS_CLOUD_RELAY_ACME_JOURNAL: z.string().min(1),
  OMNESIS_CLOUD_RELAY_DOMAIN: z.string().min(1),
});

/** Run on an independent host/credential boundary. It needs no relay session key or account database. */
export async function startIndependentDnsDaemon(
  env: NodeJS.ProcessEnv,
): Promise<{ url: string; close(): Promise<void> }> {
  const config = schema.parse(env);
  const certFile = config.OMNESIS_CLOUD_RELAY_DNS_BROKER_TLS_CERT_FILE,
    keyFile = config.OMNESIS_CLOUD_RELAY_DNS_BROKER_TLS_KEY_FILE;
  if (Boolean(certFile) !== Boolean(keyFile))
    throw new Error("DNS broker TLS requires certificate and key");
  if (!certFile && !["127.0.0.1", "::1"].includes(config.OMNESIS_CLOUD_RELAY_DNS_BROKER_BIND))
    throw new Error("Non-loopback DNS broker listeners require TLS");
  const policy = await loadRelayRecoveryPolicy(env);
  if (!policy)
    throw new Error("Independent DNS requires an independent current recovery authority");
  const { token } = z
    .object({ token: z.string().min(1).max(8192) })
    .strict()
    .parse(await readPrivateJson(config.OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE));
  const dns = await AcmeDnsChallenges.open({
    file: config.OMNESIS_CLOUD_RELAY_ACME_JOURNAL,
    suffix: config.OMNESIS_CLOUD_RELAY_DOMAIN,
    provider: cloudflareDnsProvider({
      zoneId: config.OMNESIS_CLOUD_RELAY_ACME_ZONE_ID,
      zoneName: config.OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME,
      token,
    }),
  });
  let broker: ReturnType<typeof createIndependentDnsBroker>;
  try {
    broker = createIndependentDnsBroker({
      origin: config.OMNESIS_ACME_DNS_BROKER_URL,
      policy,
      dns,
      tls:
        certFile && keyFile
          ? { cert: await readFile(certFile, "utf8"), key: await readFile(keyFile, "utf8") }
          : undefined,
    });
  } catch (error) {
    await dns.close().catch(() => {});
    throw error;
  }
  try {
    broker.server.listen(
      config.OMNESIS_CLOUD_RELAY_DNS_BROKER_PORT,
      config.OMNESIS_CLOUD_RELAY_DNS_BROKER_BIND,
    );
    await once(broker.server, "listening");
  } catch (error) {
    await broker.close().catch(() => {});
    throw error;
  }
  const address = broker.server.address() as AddressInfo;
  const hostname = address.address.includes(":") ? `[${address.address}]` : address.address;
  return {
    url: `${certFile ? "https" : "http"}://${hostname}:${address.port}`,
    close: broker.close,
  };
}
