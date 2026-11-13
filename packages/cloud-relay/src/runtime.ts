// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { z } from "zod";
import { DEFAULT_CONFIG_DIR, resolveTlsMaterial } from "@omnesis/core";
import { accountRuntimeConfiguration } from "./account-runtime-configuration.js";
import { RelayAccounts } from "./accounts.js";
import { googleIdentityProvider, localIdentityProvider, RelaySessions } from "./identity.js";
import { createCloudRelay } from "./server.js";
import { createRelayClientProxy } from "./client-proxy.js";
import { directCandidateSchema } from "./direct-path.js";
import { tlsSpkiFingerprint } from "./pinned-key.js";
import { AdaptiveGatewayPath } from "./adaptive-path.js";
import { saveDirectCandidates } from "./device-file-hints.js";
import { probeGatewayDevice } from "./adaptive-probe.js";
import { discoverDirectCandidates, pinnedGatewayJson } from "./google-device-pairing.js";
import { relayOrigin } from "./network.js";
import {
  publicGatewayCertificateFile,
  publicGatewayPrivateKeyFile,
  publicGatewayOrigin,
} from "./gateway-certificate.js";
import { ensureAcmeBootstrap } from "./acme-bootstrap.js";
import { AcmeDnsChallenges } from "./acme-dns.js";
import { cloudflareDnsProvider, fixtureDnsApiUrl } from "./cloudflare-dns.js";
import { DEFAULT_TUNNEL_LIMITS } from "./tunnels.js";
import { runGoogleRelayLogin, runAccountDevicePairing } from "./google-commands.js";
import { bindingOrigin, certificateFingerprint } from "./gateway-binding.js";
import { readPrivateJson, savePrivateJson } from "./google-credentials.js";
import { runGatewayGoogleLink } from "./gateway-google-link.js";
import { registerGatewayKey, prepareGatewayOwner } from "./gateway-key-client.js";
import { loadRelayRecoveryPolicy, runRelayRecoveryCommand } from "./relay-recovery-runtime.js";
import { assertRelayDnsIsolation, startIndependentDnsDaemon } from "./dns-broker-runtime.js";
import { googleBrowserConfiguration } from "./google-browser-runtime.js";
import { googleFixture } from "./google-fixture.js";
import { CloudRelayMetrics } from "./metrics.js";
import { startRelayMetricsServer } from "./metrics-server.js";
import { ProxyProtocolPeers } from "./proxy-protocol.js";
import { cdnFront } from "./cdn-front.js";
import type { RelayWebLoginOptions } from "./relay-web-login.js";
import type { AddressInfo } from "node:net";

const positive = z.coerce.number().int().positive().max(2_147_483_647);
const envSchema = z.object({
  OMNESIS_CLOUD_RELAY_BIND: z.string().default("127.0.0.1"),
  OMNESIS_CLOUD_RELAY_METRICS_PORT: z.coerce.number().int().min(0).max(65535).optional(),
  OMNESIS_CLOUD_RELAY_PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  OMNESIS_CLOUD_RELAY_PUBLIC_DATA_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  OMNESIS_CLOUD_RELAY_DATA_PORT: z.coerce.number().int().min(0).max(65535).optional(),
  OMNESIS_CLOUD_RELAY_DOMAIN: z
    .string()
    .regex(/^[a-z0-9.-]+$/)
    .optional(),
  OMNESIS_CLOUD_RELAY_ACME_ZONE_ID: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_ACME_JOURNAL: z.string().min(1).optional(),
  /** Test-only loopback DNS API; see fixtureDnsApiUrl. */
  OMNESIS_CLOUD_RELAY_ACME_DNS_API_URL: z.string().min(1).optional(),
  /** Test-only loopback stand-in for Google's endpoints; see googleFixture. */
  OMNESIS_CLOUD_RELAY_GOOGLE_FIXTURE_URL: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_DB: z.string().min(1),
  OMNESIS_CLOUD_RELAY_KEY_FILE: z.string().min(1),
  OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CLIENT_ID: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_SECRET_FILE: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE: z.string().min(1).optional(),
  OMNESIS_SYNTHETIC: z.literal("1").optional(),
  OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_TLS_CERT_FILE: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_TLS_KEY_FILE: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_MAX_ACCOUNTS: positive.default(100),
  OMNESIS_CLOUD_RELAY_MAX_CONCURRENT_LOGINS: positive.default(8),
  OMNESIS_CLOUD_RELAY_MAX_LOGINS_PER_MINUTE: positive.default(60),
  /** Per client address; unset means half the concurrent and a third of the per-minute limit. */
  OMNESIS_CLOUD_RELAY_MAX_CONCURRENT_LOGINS_PER_CLIENT: positive.optional(),
  OMNESIS_CLOUD_RELAY_MAX_LOGINS_PER_MINUTE_PER_CLIENT: positive.optional(),
  OMNESIS_CLOUD_RELAY_MAX_GATEWAYS: positive.default(DEFAULT_TUNNEL_LIMITS.maxGateways),
  OMNESIS_CLOUD_RELAY_MAX_STREAMS: positive.default(DEFAULT_TUNNEL_LIMITS.maxStreams),
  OMNESIS_CLOUD_RELAY_MAX_STREAMS_PER_GATEWAY: positive.default(
    DEFAULT_TUNNEL_LIMITS.maxStreamsPerGateway,
  ),
  OMNESIS_CLOUD_RELAY_CONNECT_TIMEOUT_MS: positive.default(DEFAULT_TUNNEL_LIMITS.connectTimeoutMs),
  OMNESIS_CLOUD_RELAY_HEARTBEAT_MS: positive.default(DEFAULT_TUNNEL_LIMITS.heartbeatMs),
  /**
   * Comma-separated peer IPs or CIDR ranges (the TCP front layer) that must open
   * every connection with a PROXY protocol header. Unset: no header is ever read.
   */
  OMNESIS_CLOUD_RELAY_PROXY_PROTOCOL_FROM: z.string().min(1).optional(),
  /**
   * A TLS-terminating reverse proxy (a CDN) in front of the control listener: its address
   * ranges, comma-separated or one per line in a file that is read again every few minutes.
   * Only requests from them have their client address header read. Unset: no header is read.
   */
  OMNESIS_CLOUD_RELAY_TRUSTED_PROXIES: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_TRUSTED_PROXIES_FILE: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_CLIENT_ADDRESS_HEADER: z.string().min(1).optional(),
  /** This listener's address that bypasses the proxy; gateways move their tunnel to it. */
  OMNESIS_CLOUD_RELAY_TUNNEL_ORIGIN: z.string().min(1).optional(),
  /** `tunnel`: connections that bypass the proxy get the gateway tunnel and nothing else. */
  OMNESIS_CLOUD_RELAY_DIRECT_ROUTES: z.enum(["all", "tunnel"]).optional(),
  /** `1` keeps the routes from before Omnesis accounts for Google-era clients; see the README. */
  OMNESIS_CLOUD_RELAY_LEGACY_ROUTES: z.enum(["0", "1"]).optional(),
});

export async function startRelayDaemon(
  env: NodeJS.ProcessEnv,
): Promise<{ url: string; dataPort: number; metricsPort?: number; close(): Promise<void> }> {
  const config = envSchema.parse(env);
  const proxyProtocolPeers = ProxyProtocolPeers.parse(
    config.OMNESIS_CLOUD_RELAY_PROXY_PROTOCOL_FROM,
  );
  const cdn = cdnFront({
    trustedProxies: config.OMNESIS_CLOUD_RELAY_TRUSTED_PROXIES,
    trustedProxiesFile: config.OMNESIS_CLOUD_RELAY_TRUSTED_PROXIES_FILE,
    clientAddressHeader: config.OMNESIS_CLOUD_RELAY_CLIENT_ADDRESS_HEADER,
    tunnelOrigin: config.OMNESIS_CLOUD_RELAY_TUNNEL_ORIGIN,
    directRoutes: config.OMNESIS_CLOUD_RELAY_DIRECT_ROUTES,
  });
  const metrics = new CloudRelayMetrics();
  assertRelayDnsIsolation(env);
  const recoveryPolicy = await loadRelayRecoveryPolicy(env);
  const tlsCert = config.OMNESIS_CLOUD_RELAY_TLS_CERT_FILE;
  const tlsKey = config.OMNESIS_CLOUD_RELAY_TLS_KEY_FILE;
  if (Boolean(tlsCert) !== Boolean(tlsKey))
    throw new Error("Relay TLS requires both certificate and key");
  if (!tlsCert && !["127.0.0.1", "::1"].includes(config.OMNESIS_CLOUD_RELAY_BIND)) {
    throw new Error("Non-loopback relay listeners require TLS");
  }
  const mockKey = config.OMNESIS_CLOUD_RELAY_MOCK_KEY_FILE;
  const fixture = googleFixture(
    config.OMNESIS_CLOUD_RELAY_GOOGLE_FIXTURE_URL,
    config.OMNESIS_CLOUD_RELAY_BIND,
    config.OMNESIS_SYNTHETIC === "1",
  );
  const webClient = config.OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID;
  const gatewayClient = config.OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_CLIENT_ID;
  const gatewayWebClient = config.OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CLIENT_ID;
  const gatewayClients = [gatewayClient, gatewayWebClient].filter((value): value is string =>
    Boolean(value),
  );
  const clientIds = config.OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID?.split(",").map((id) => id.trim());
  const androidClients =
    config.OMNESIS_CLOUD_RELAY_GOOGLE_ANDROID_CLIENT_ID?.split(",").map((id) => id.trim()) ?? [];
  if (
    gatewayClients.some(
      (id) => clientIds?.includes(id) || id === webClient || androidClients.includes(id),
    ) ||
    (gatewayClient && gatewayClient === gatewayWebClient)
  )
    throw new Error("Gateway attestation requires a separate desktop Google OAuth client");
  if (mockKey && (clientIds || gatewayClients.length || webClient || androidClients.length))
    throw new Error("Choose Google or local mock identity, never both");
  let webLogin: Omit<RelayWebLoginOptions, "accountBrowser"> | undefined;
  if (
    webClient &&
    config.OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE &&
    config.OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN
  ) {
    let secret: string;
    try {
      secret = z
        .object({
          web: z.object({
            client_id: z.literal(webClient),
            client_secret: z
              .string()
              .min(1)
              .max(8192)
              .refine((value) => value.trim().length > 0),
          }),
        })
        .parse(await readPrivateJson(config.OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE))
        .web.client_secret;
    } catch {
      throw new Error("Invalid Google web OAuth credential file");
    }
    webLogin = {
      clientId: webClient,
      clientSecret: secret,
      publicOrigin: bindingOrigin(config.OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN).origin,
      identity: googleIdentityProvider(webClient, fixture?.keys),
      ...(fixture
        ? { fetch: fixture.fetch, authorizationEndpoint: fixture.authorizationEndpoint }
        : {}),
    };
  }
  const audiences = [
    ...new Set([
      ...(clientIds ?? []),
      ...(webClient ? [webClient] : []),
      ...(gatewayClient ? [gatewayClient] : []),
    ]),
  ];
  const identity = mockKey
    ? localIdentityProvider(await readFile(mockKey), config.OMNESIS_CLOUD_RELAY_BIND)
    : audiences.length
      ? googleIdentityProvider(audiences, fixture?.keys, {
          authorizedParties: [...new Set([...audiences, ...androidClients])],
        })
      : undefined;
  const deviceAudiences = [...new Set([...(clientIds ?? []), ...(webClient ? [webClient] : [])])];
  const googleBrowser = await googleBrowserConfiguration(env, webLogin, deviceAudiences, [
    ...new Set([...deviceAudiences, ...androidClients]),
  ]);
  const sessions = new RelaySessions(await readFile(config.OMNESIS_CLOUD_RELAY_KEY_FILE));
  const tls =
    tlsCert && tlsKey
      ? { cert: await readFile(tlsCert, "utf8"), key: await readFile(tlsKey, "utf8") }
      : undefined;
  await mkdir(dirname(config.OMNESIS_CLOUD_RELAY_DB), { recursive: true, mode: 0o700 });
  const accounts = new RelayAccounts(
    config.OMNESIS_CLOUD_RELAY_DB,
    config.OMNESIS_CLOUD_RELAY_MAX_ACCOUNTS,
  );
  let relay: ReturnType<typeof createCloudRelay>;
  let acmeDns: AcmeDnsChallenges | undefined;
  try {
    if (
      config.OMNESIS_CLOUD_RELAY_ACME_ZONE_ID ||
      config.OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME ||
      config.OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE ||
      config.OMNESIS_CLOUD_RELAY_ACME_JOURNAL
    ) {
      if (
        !config.OMNESIS_CLOUD_RELAY_ACME_ZONE_ID ||
        !config.OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME ||
        !config.OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE ||
        !config.OMNESIS_CLOUD_RELAY_ACME_JOURNAL ||
        !config.OMNESIS_CLOUD_RELAY_DOMAIN
      )
        throw new Error(
          "Managed ACME DNS requires zone, private token file, journal and relay domain",
        );
      const { token } = z
        .object({ token: z.string().min(1).max(8192) })
        .parse(await readPrivateJson(config.OMNESIS_CLOUD_RELAY_ACME_TOKEN_FILE));
      acmeDns = await AcmeDnsChallenges.open({
        file: config.OMNESIS_CLOUD_RELAY_ACME_JOURNAL,
        suffix: config.OMNESIS_CLOUD_RELAY_DOMAIN,
        provider: cloudflareDnsProvider({
          metrics,
          zoneId: config.OMNESIS_CLOUD_RELAY_ACME_ZONE_ID,
          zoneName: config.OMNESIS_CLOUD_RELAY_ACME_ZONE_NAME,
          token,
          ...(config.OMNESIS_CLOUD_RELAY_ACME_DNS_API_URL
            ? {
                apiUrl: fixtureDnsApiUrl(
                  config.OMNESIS_CLOUD_RELAY_ACME_DNS_API_URL,
                  config.OMNESIS_CLOUD_RELAY_BIND,
                ),
              }
            : {}),
        }),
      });
    }
    relay = createCloudRelay({
      metrics,
      recoveryPolicy,
      identity,
      acmeDns,
      allowLoopbackEnrollment: config.OMNESIS_SYNTHETIC === "1",
      controlOrigin: config.OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN
        ? relayOrigin(config.OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN).origin
        : undefined,
      gatewayIdentity: mockKey
        ? identity
        : gatewayClients.length
          ? googleIdentityProvider(gatewayClients)
          : undefined,
      sessions,
      accounts,
      webLogin,
      accountSignIn: await accountRuntimeConfiguration({
        env,
        database: config.OMNESIS_CLOUD_RELAY_DB,
        origin: config.OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN,
        googleFetch: fixture?.fetch,
        nativeGoogleIdentity: mockKey
          ? identity
          : deviceAudiences.length
            ? googleIdentityProvider(deviceAudiences, fixture?.keys, {
                authorizedParties: [...new Set([...deviceAudiences, ...androidClients])],
              })
            : undefined,
      }),
      googleBrowser,
      tls,
      relayDomain: config.OMNESIS_CLOUD_RELAY_DOMAIN,
      publicDataPort: config.OMNESIS_CLOUD_RELAY_PUBLIC_DATA_PORT,
      proxyProtocolPeers,
      cdn,
      legacyRoutes: config.OMNESIS_CLOUD_RELAY_LEGACY_ROUTES === "1",
      loginLimits: {
        maxConcurrent: config.OMNESIS_CLOUD_RELAY_MAX_CONCURRENT_LOGINS,
        maxPerMinute: config.OMNESIS_CLOUD_RELAY_MAX_LOGINS_PER_MINUTE,
        maxConcurrentPerClient: config.OMNESIS_CLOUD_RELAY_MAX_CONCURRENT_LOGINS_PER_CLIENT,
        maxPerMinutePerClient: config.OMNESIS_CLOUD_RELAY_MAX_LOGINS_PER_MINUTE_PER_CLIENT,
      },
      limits: {
        maxGateways: config.OMNESIS_CLOUD_RELAY_MAX_GATEWAYS,
        maxStreams: config.OMNESIS_CLOUD_RELAY_MAX_STREAMS,
        maxStreamsPerGateway: config.OMNESIS_CLOUD_RELAY_MAX_STREAMS_PER_GATEWAY,
        connectTimeoutMs: config.OMNESIS_CLOUD_RELAY_CONNECT_TIMEOUT_MS,
        heartbeatMs: config.OMNESIS_CLOUD_RELAY_HEARTBEAT_MS,
      },
    });
  } catch (error) {
    await acmeDns?.close().catch(() => {});
    accounts.close();
    throw error;
  }
  let metricsServer: Awaited<ReturnType<typeof startRelayMetricsServer>> | undefined;
  try {
    relay.server.listen(config.OMNESIS_CLOUD_RELAY_PORT, config.OMNESIS_CLOUD_RELAY_BIND);
    await once(relay.server, "listening");
    relay.dataServer.listen(
      config.OMNESIS_CLOUD_RELAY_DATA_PORT ?? (config.OMNESIS_CLOUD_RELAY_PORT === 0 ? 0 : 8789),
      config.OMNESIS_CLOUD_RELAY_BIND,
    );
    await once(relay.dataServer, "listening");
    if (config.OMNESIS_CLOUD_RELAY_METRICS_PORT !== undefined)
      metricsServer = await startRelayMetricsServer(config.OMNESIS_CLOUD_RELAY_METRICS_PORT, () =>
        relay.metrics(),
      );
  } catch (error) {
    // DNS leases and tunnel timers are owned even when the first listener never opened.
    await relay.close().catch(() => {});
    accounts.close();
    throw error;
  }
  const address = relay.server.address() as AddressInfo;
  const host = config.OMNESIS_CLOUD_RELAY_BIND.includes(":")
    ? `[${config.OMNESIS_CLOUD_RELAY_BIND}]`
    : config.OMNESIS_CLOUD_RELAY_BIND;
  return {
    url: `${tlsCert ? "https" : "http"}://${host}:${address.port}`,
    dataPort: (relay.dataServer.address() as AddressInfo).port,
    metricsPort: metricsServer?.port,
    async close() {
      try {
        await metricsServer?.close();
      } finally {
        try {
          await relay.close();
        } finally {
          accounts.close();
        }
      }
    },
  };
}

export async function loginRelay(options: {
  relayUrl: string;
  idTokenFile: string;
  sessionFile: string;
}): Promise<void> {
  const relay = relayOrigin(options.relayUrl);
  const response = await fetch(new URL("/_relay/v1/login", relay), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken: (await readFile(options.idTokenFile, "utf8")).trim() }),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Relay login failed (${response.status})`);
  const session = z
    .object({
      token: z.string().min(1).max(4096),
      expiresAt: z.number().int().positive(),
      accountId: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(await response.json());
  await mkdir(dirname(options.sessionFile), { recursive: true, mode: 0o700 });
  const temporary = `${options.sessionFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(session) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, options.sessionFile);
}

export async function runRelayCommand(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<{ url: string; gatewayUrl?: string; close(): Promise<void> } | undefined> {
  if (await runRelayRecoveryCommand(command, env)) return undefined;
  if (command === "serve-dns-broker") return startIndependentDnsDaemon(env);
  if (command === "serve") return startRelayDaemon(env);
  if (command === "link-google" || command === "unlink-google") {
    await runGatewayGoogleLink(command, env);
    return;
  }
  if (command === "prepare-owner") {
    const config = z
      .object({
        OMNESIS_CLOUD_RELAY_SESSION_FILE: z.string().min(1),
        OMNESIS_CLOUD_RELAY_GATEWAY_ID: z.string().uuid(),
        OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: z.string().min(1).optional(),
        OMNESIS_PUBLIC_BASE_URL: z.string().min(1).optional(),
        OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: z.string().min(1).optional(),
      })
      .parse(env);
    const details = await prepareGatewayOwner({
      sessionFile: config.OMNESIS_CLOUD_RELAY_SESSION_FILE,
      gatewayId: config.OMNESIS_CLOUD_RELAY_GATEWAY_ID,
      ownerKeyFile: config.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE,
      publicOrigin:
        config.OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN || config.OMNESIS_PUBLIC_BASE_URL
          ? publicGatewayOrigin(env)
          : undefined,
    });
    process.stdout.write(JSON.stringify(details) + "\n");
    return;
  }
  if (command === "issue-invite") {
    const config = z
      .object({
        OMNESIS_CLOUD_RELAY_KEY_FILE: z.string().min(1),
        OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE: z.string().min(1),
        OMNESIS_CLOUD_RELAY_GATEWAY_ID: z.string().uuid(),
        OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: z.string().min(1),
      })
      .parse(env);
    const sessions = new RelaySessions(await readFile(config.OMNESIS_CLOUD_RELAY_KEY_FILE));
    const enrollmentToken = await sessions.issueEnrollmentInvitation(
      config.OMNESIS_CLOUD_RELAY_GATEWAY_ID,
      config.OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN,
    );
    await savePrivateJson(config.OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE, { enrollmentToken });
    return undefined;
  }
  if (command === "register-key") {
    const config = z
      .object({
        OMNESIS_CLOUD_RELAY_URL: z.string().min(1),
        OMNESIS_CLOUD_RELAY_SESSION_FILE: z.string().min(1),
        OMNESIS_CLOUD_RELAY_GATEWAY_ID: z.string().uuid(),
        OMNESIS_PUBLIC_BASE_URL: z.string().min(1).optional(),
        OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: z.string().min(1).optional(),
        OMNESIS_TLS_CERT: z.string().min(1).optional(),
        OMNESIS_TLS_KEY: z.string().min(1).optional(),
        OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: z.string().min(1).optional(),
        OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE: z.string().min(1).optional(),
      })
      .parse(env);
    const publicOrigin = publicGatewayOrigin(env);
    const certificateFile = publicGatewayCertificateFile(env),
      privateKeyFile = publicGatewayPrivateKeyFile(env);
    if (env.OMNESIS_ACME_DIRECTORY_URL) {
      const direct = resolveTlsMaterial({
        configDir: env.OMNESIS_CONFIG_DIR ?? DEFAULT_CONFIG_DIR,
        certPath: config.OMNESIS_TLS_CERT,
        keyPath: config.OMNESIS_TLS_KEY,
      });
      if (
        resolve(certificateFile) === resolve(direct.certPath) ||
        resolve(certificateFile) === resolve(direct.keyPath)
      )
        throw new Error("Public ACME certificate requires its own path");
      if (
        [direct.certPath, direct.keyPath, certificateFile].some(
          (path) => resolve(path) === resolve(privateKeyFile),
        )
      )
        throw new Error("Public ACME requires a separate stable private key path");
      await ensureAcmeBootstrap({
        publicOrigin,
        certificateFile,
        privateKeyFile,
        generatePrivateKey: true,
        signal: AbortSignal.timeout(15_000),
      });
    }
    await registerGatewayKey({
      relayUrl: config.OMNESIS_CLOUD_RELAY_URL,
      sessionFile: config.OMNESIS_CLOUD_RELAY_SESSION_FILE,
      gatewayId: config.OMNESIS_CLOUD_RELAY_GATEWAY_ID,
      publicOrigin,
      certificateFile,
      privateKeyFile,
      ownerKeyFile: config.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE,
      enrollmentTokenFile: config.OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE,
      recoveryReceiptFile: env.OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE,
    });
    return undefined;
  }
  if (command === "pair-device") {
    await runAccountDevicePairing(env);
    return undefined;
  }
  if (command === "google-login" || command === "register-gateway") {
    await runGoogleRelayLogin(command, env);
    return undefined;
  }
  if (command === "login") {
    const options = z
      .object({
        OMNESIS_CLOUD_RELAY_URL: z.string().min(1),
        OMNESIS_CLOUD_RELAY_SESSION_FILE: z.string().min(1),
        OMNESIS_CLOUD_RELAY_ID_TOKEN_FILE: z.string().min(1),
      })
      .parse(env);
    await loginRelay({
      relayUrl: options.OMNESIS_CLOUD_RELAY_URL,
      idTokenFile: options.OMNESIS_CLOUD_RELAY_ID_TOKEN_FILE,
      sessionFile: options.OMNESIS_CLOUD_RELAY_SESSION_FILE,
    });
    return undefined;
  }
  if (command !== "client")
    throw new Error(
      "Usage: cloud-relay <serve|serve-dns-broker|login|prepare-owner|issue-invite|register-key|link-google|unlink-google|google-login|register-gateway|pair-device|client|recovery-*>",
    );
  const port = z.coerce
    .number()
    .int()
    .min(0)
    .max(65535)
    .default(8788)
    .parse(env.OMNESIS_CLOUD_RELAY_CLIENT_PORT);
  const paired = env.OMNESIS_CLOUD_RELAY_DEVICE_FILE
    ? z
        .object({
          gatewayUrl: z.string().min(1).max(2048),
          gatewayFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          gatewayCertificate: z.string().min(1).max(16_384),
          tlsSpkiFingerprint: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          directCandidates: z.array(directCandidateSchema).max(8).optional(),
          token: z.string().regex(/^[A-Za-z0-9._~-]{1,4096}$/),
          deviceId: z.string().uuid(),
          kind: z.enum(["cli", "collector"]),
          scopes: z.array(z.string().min(1).max(128)).max(128),
        })
        .strict()
        .parse(await readPrivateJson(env.OMNESIS_CLOUD_RELAY_DEVICE_FILE))
    : undefined;
  if (paired) {
    const certificate = new X509Certificate(paired.gatewayCertificate);
    if (
      certificate.toString().trim() !== paired.gatewayCertificate.trim() ||
      !certificate.checkHost(bindingOrigin(paired.gatewayUrl).hostname) ||
      certificateFingerprint(paired.gatewayCertificate) !== paired.gatewayFingerprint ||
      (paired.tlsSpkiFingerprint !== undefined &&
        tlsSpkiFingerprint(paired.gatewayCertificate) !== paired.tlsSpkiFingerprint)
    )
      throw new Error("Paired gateway certificate does not match its saved identity");
  }
  const deviceFile = env.OMNESIS_CLOUD_RELAY_DEVICE_FILE;
  const adaptivePath: AdaptiveGatewayPath | undefined =
    paired?.directCandidates !== undefined
      ? new AdaptiveGatewayPath({
          candidates: paired.directCandidates,
          refresh: (saved, signal, dial) =>
            discoverDirectCandidates(
              { publicOrigin: paired.gatewayUrl, certificate: paired.gatewayCertificate },
              paired.token,
              signal,
              // The canonical dial of a refresh honours the same address override as traffic does.
              (target, path, body, deadline, _host, options) =>
                pinnedGatewayJson(
                  target,
                  path,
                  body,
                  deadline,
                  env.OMNESIS_CLOUD_RELAY_GATEWAY_CONNECT_IP,
                  options,
                ),
              saved,
              paired.tlsSpkiFingerprint,
              dial,
            ),
          persist: (candidates) => saveDirectCandidates(deviceFile!, paired, candidates),
          reverify:
            paired.tlsSpkiFingerprint === undefined
              ? undefined
              : async (signal) => {
                  await probeGatewayDevice({
                    gateway: {
                      publicOrigin: paired.gatewayUrl,
                      certificate: paired.gatewayCertificate,
                    },
                    deviceId: paired.deviceId,
                    token: paired.token,
                    candidates: [],
                    connectHost: env.OMNESIS_CLOUD_RELAY_GATEWAY_CONNECT_IP,
                    tlsSpkiFingerprint: paired.tlsSpkiFingerprint,
                    signal,
                  });
                },
          probe: (candidate, signal) =>
            probeGatewayDevice({
              gateway: { publicOrigin: paired.gatewayUrl, certificate: paired.gatewayCertificate },
              deviceId: paired.deviceId,
              token: paired.token,
              candidate,
              candidates: adaptivePath!.candidates(),
              tlsSpkiFingerprint: paired.tlsSpkiFingerprint,
              signal,
            }),
        })
      : undefined;
  if (adaptivePath) {
    // One look before the first connection: it decides whether connections start on the home
    // network or on the relay, and refuses to start on an identity or authorization failure.
    await adaptivePath.check();
    try {
      adaptivePath.assertUsable();
    } catch (error) {
      adaptivePath.close();
      throw error;
    }
  }
  const proxy = createRelayClientProxy({
    adaptivePath,
    gatewayUrl: paired?.gatewayUrl ?? z.string().min(1).parse(env.OMNESIS_CLOUD_RELAY_GATEWAY_URL),
    gatewayFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(paired?.gatewayFingerprint ?? env.OMNESIS_CLOUD_RELAY_GATEWAY_FINGERPRINT),
    gatewayConnectHost: env.OMNESIS_CLOUD_RELAY_GATEWAY_CONNECT_IP,
    directCandidates: adaptivePath?.candidates(),
    tlsSpkiFingerprint: paired?.tlsSpkiFingerprint,
    expectedGatewayToken: paired?.token,
    gatewayCa:
      paired?.gatewayCertificate ??
      (env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE
        ? await readFile(env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE, "utf8")
        : undefined),
  });
  const { server } = proxy;
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  if (env.OMNESIS_CLOUD_RELAY_CLIENT_UNREF === "1") server.unref();
  adaptivePath?.start();
  return {
    url: `http://127.0.0.1:${address.port}`,
    gatewayUrl: paired?.gatewayUrl ?? env.OMNESIS_CLOUD_RELAY_GATEWAY_URL,
    close: async () => {
      adaptivePath?.close();
      await proxy.close();
    },
  };
}
