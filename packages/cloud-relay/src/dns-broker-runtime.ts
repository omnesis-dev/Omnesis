// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { z } from "zod";
import { AcmeDnsChallenges } from "./acme-dns.js";
import { cloudflareDnsProvider, fixtureDnsApiUrl } from "./cloudflare-dns.js";
import { createIndependentDnsBroker } from "./independent-dns-server.js";
import { DnsBroker } from "./dns-broker-core.js";
import { cloudflareBrokerZone } from "./dns-broker-zone.js";
import { FileBrokerStore, createDnsBrokerServer } from "./dns-broker-node.js";
import { loadRelayRecoveryPolicy } from "./relay-recovery-runtime.js";
import { readPrivateJson } from "./google-credentials.js";
import type { TrustedRecoveryPolicy } from "./recovery-verifier.js";
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
  /** Version 1 (recovery receipts) only; served when a recovery policy is configured. */
  OMNESIS_CLOUD_RELAY_ACME_JOURNAL: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_DOMAIN: z.string().min(1),
  /** The name registry and lease journal of version 2, a private file on this host. */
  OMNESIS_CLOUD_RELAY_DNS_BROKER_REGISTRY: z.string().min(1),
  /** A private JSON file `{ "token": … }` that enables the one-time registry import. */
  OMNESIS_CLOUD_RELAY_DNS_BROKER_IMPORT_TOKEN_FILE: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_DNS_BROKER_CAA_ACCOUNT_URI_PREFIX: z.string().min(1).optional(),
  /** Test-only loopback stand-in for the Cloudflare API; see fixtureDnsApiUrl. */
  OMNESIS_CLOUD_RELAY_DNS_BROKER_FIXTURE_DNS_API_URL: z.string().min(1).optional(),
});

const tokenFileSchema = z.object({ token: z.string().min(1).max(8192) }).strict();

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
  if (policy && !config.OMNESIS_CLOUD_RELAY_ACME_JOURNAL)
    throw new Error("Receipt-authorized DNS requires its challenge journal");
  const { token } = tokenFileSchema.parse(
    await readPrivateJson(config.OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE),
  );
  const importToken = config.OMNESIS_CLOUD_RELAY_DNS_BROKER_IMPORT_TOKEN_FILE
    ? tokenFileSchema.parse(
        await readPrivateJson(config.OMNESIS_CLOUD_RELAY_DNS_BROKER_IMPORT_TOKEN_FILE),
      ).token
    : undefined;
  const broker = new DnsBroker({
    origin: config.OMNESIS_ACME_DNS_BROKER_URL,
    relayDomain: config.OMNESIS_CLOUD_RELAY_DOMAIN,
    importToken,
    caa: config.OMNESIS_CLOUD_RELAY_DNS_BROKER_CAA_ACCOUNT_URI_PREFIX
      ? { accountUriPrefix: config.OMNESIS_CLOUD_RELAY_DNS_BROKER_CAA_ACCOUNT_URI_PREFIX }
      : {},
    store: await FileBrokerStore.open(config.OMNESIS_CLOUD_RELAY_DNS_BROKER_REGISTRY),
    zone: cloudflareBrokerZone({
      zoneId: config.OMNESIS_CLOUD_RELAY_ACME_ZONE_ID,
      zoneName: config.OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME,
      relayDomain: config.OMNESIS_CLOUD_RELAY_DOMAIN,
      token,
      ...(config.OMNESIS_CLOUD_RELAY_DNS_BROKER_FIXTURE_DNS_API_URL
        ? {
            apiUrl: fixtureDnsApiUrl(
              config.OMNESIS_CLOUD_RELAY_DNS_BROKER_FIXTURE_DNS_API_URL,
              config.OMNESIS_CLOUD_RELAY_DNS_BROKER_BIND,
            ),
          }
        : {}),
    }),
  });
  // Leases a previous process left behind are removed before anything is served.
  await broker.expire();
  const tls =
    certFile && keyFile
      ? { cert: await readFile(certFile, "utf8"), key: await readFile(keyFile, "utf8") }
      : undefined;
  const legacy = policy
    ? await legacyBroker(config.OMNESIS_ACME_DNS_BROKER_URL, policy, {
        file: config.OMNESIS_CLOUD_RELAY_ACME_JOURNAL!,
        suffix: config.OMNESIS_CLOUD_RELAY_DOMAIN,
        zoneId: config.OMNESIS_CLOUD_RELAY_ACME_ZONE_ID,
        zoneName: config.OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME,
        token,
      })
    : undefined;
  const served = createDnsBrokerServer({ broker, tls, legacy: legacy?.server });
  const close = async () => {
    const failed = (await Promise.allSettled([served.close(), legacy?.close()])).find(
      (result) => result.status === "rejected",
    );
    if (failed) throw failed.reason;
  };
  try {
    served.server.listen(
      config.OMNESIS_CLOUD_RELAY_DNS_BROKER_PORT,
      config.OMNESIS_CLOUD_RELAY_DNS_BROKER_BIND,
    );
    await once(served.server, "listening");
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  const address = served.server.address() as AddressInfo;
  const hostname = address.address.includes(":") ? `[${address.address}]` : address.address;
  return {
    url: `${certFile ? "https" : "http"}://${hostname}:${address.port}`,
    close,
  };
}

/** Version 1: operations authorized by operator-signed recovery receipts, not by the registry. */
async function legacyBroker(
  origin: string,
  policy: TrustedRecoveryPolicy,
  journal: { file: string; suffix: string; zoneId: string; zoneName: string; token: string },
) {
  const dns = await AcmeDnsChallenges.open({
    file: journal.file,
    suffix: journal.suffix,
    provider: cloudflareDnsProvider({
      zoneId: journal.zoneId,
      zoneName: journal.zoneName,
      token: journal.token,
    }),
  });
  // The origin already passed the stricter version 2 check, so construction can't fail here.
  return createIndependentDnsBroker({ origin, policy, dns });
}
