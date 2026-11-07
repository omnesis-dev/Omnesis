// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createLogger, experimentalEnabled, resolveTlsMaterial } from "@omnesis/core";
import { z } from "zod";
import { ensureAcmeBootstrap } from "./acme-bootstrap.js";
import { AcmeDnsChallenges } from "./acme-dns.js";
import { cloudflareDnsProvider } from "./cloudflare-dns.js";
import { readPrivateJson } from "./google-credentials.js";
import {
  gatewayKeySessionSource,
  prepareGatewayOwner,
  registerGatewayKey,
} from "./gateway-key-client.js";
import { independentDnsPresenter } from "./independent-dns-client.js";
import { publicGatewayOrigin } from "./gateway-certificate.js";
import { publicKeyFingerprint } from "./gateway-key-auth.js";
import { bindingOrigin } from "./gateway-binding.js";

const schema = z.object({
  OMNESIS_ACME_DIRECTORY_URL: z.string().url(),
  OMNESIS_ACME_TERMS_ACCEPTED: z.literal("1"),
  OMNESIS_ACME_DNS_PROVIDER: z.enum(["relay", "cloudflare", "independent"]).default("relay"),
  OMNESIS_ACME_ACCOUNT_KEY_FILE: z.string().min(1).optional(),
  OMNESIS_ACME_DNS_ZONE_ID: z.string().min(1).optional(),
  OMNESIS_ACME_DNS_ZONE_NAME: z.string().min(1).optional(),
  OMNESIS_ACME_DNS_TOKEN_FILE: z.string().min(1).optional(),
  OMNESIS_ACME_DNS_BROKER_URL: z.string().min(1).optional(),
  OMNESIS_ACME_CERT_FILE: z.string().min(1),
  OMNESIS_ACME_KEY_FILE: z.string().min(1).optional(),
  OMNESIS_TLS_CERT: z.string().min(1).optional(),
  OMNESIS_TLS_KEY: z.string().min(1).optional(),
  OMNESIS_PUBLIC_BASE_URL: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_URL: z.string().min(1),
  OMNESIS_CLOUD_RELAY_SESSION_FILE: z.string().min(1),
  OMNESIS_CLOUD_RELAY_GATEWAY_ID: z.string().uuid(),
  OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE: z.string().min(1).optional(),
  OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE: z.string().min(1).optional(),
});

/** Explicit ACME configuration adds gateway-local issuance; absent configuration performs no network/file operations. */
export async function createGatewayAcmeController(
  env: NodeJS.ProcessEnv,
  options: {
    configDir: string;
    activate(
      material: { hostname: string; cert: string; key: string },
      signal: AbortSignal,
    ): Promise<void>;
    fetch?: typeof fetch;
    issuer?: typeof import("./acme-client.js").issueAcmeCertificate;
    trustedRoots?: readonly string[];
  },
): Promise<
  | {
      renew(signal: AbortSignal): Promise<boolean>;
      fingerprintSha256(): string | undefined;
      spkiFingerprintSha256(): string | undefined;
      close(): Promise<void>;
    }
  | undefined
> {
  if (!experimentalEnabled() || !env.OMNESIS_ACME_DIRECTORY_URL) return undefined;
  const config = schema.parse(env);
  if (
    config.OMNESIS_ACME_DNS_PROVIDER === "independent" &&
    (!config.OMNESIS_ACME_DNS_BROKER_URL || config.OMNESIS_ACME_DNS_TOKEN_FILE)
  )
    throw new Error("Independent DNS requires a broker URL and no local provider token");
  if (config.OMNESIS_ACME_DNS_BROKER_URL && config.OMNESIS_ACME_DNS_PROVIDER !== "independent")
    throw new Error("A DNS broker URL requires the independent DNS provider");
  const publicOrigin = publicGatewayOrigin(env);
  const publicKeyFile = config.OMNESIS_ACME_KEY_FILE ?? `${config.OMNESIS_ACME_CERT_FILE}.key`;
  const direct = resolveTlsMaterial({
    configDir: options.configDir,
    certPath: config.OMNESIS_TLS_CERT,
    keyPath: config.OMNESIS_TLS_KEY,
  });
  if (
    resolve(config.OMNESIS_ACME_CERT_FILE) === resolve(direct.certPath) ||
    resolve(config.OMNESIS_ACME_CERT_FILE) === resolve(direct.keyPath)
  )
    throw new Error(
      "The public SNI certificate must have its own path, separate from direct TLS material",
    );
  if (
    [direct.certPath, direct.keyPath, config.OMNESIS_ACME_CERT_FILE].some(
      (path) => resolve(path) === resolve(publicKeyFile),
    )
  )
    throw new Error("Public ACME requires a separate stable private key path");
  const keyOptions = {
    relayUrl: config.OMNESIS_CLOUD_RELAY_URL,
    sessionFile: config.OMNESIS_CLOUD_RELAY_SESSION_FILE,
    gatewayId: config.OMNESIS_CLOUD_RELAY_GATEWAY_ID,
    publicOrigin: publicOrigin,
    certificateFile: config.OMNESIS_ACME_CERT_FILE,
    privateKeyFile: publicKeyFile,
    ownerKeyFile: config.OMNESIS_CLOUD_RELAY_OWNER_KEY_FILE,
    enrollmentTokenFile: config.OMNESIS_CLOUD_RELAY_ENROLLMENT_TOKEN_FILE,
    recoveryReceiptFile: env.OMNESIS_CLOUD_RELAY_RECOVERY_RECEIPT_FILE,
    fetch: options.fetch,
  };
  const accountKeyFile =
    config.OMNESIS_ACME_ACCOUNT_KEY_FILE ?? `${config.OMNESIS_ACME_CERT_FILE}.acme-account`;
  const abort = new AbortController();
  let fingerprint: string | undefined;
  let spkiFingerprint: string | undefined;
  let state:
    | { renewal: import("./acme-gateway.js").GatewayAcmeRenewal; dns?: AcmeDnsChallenges }
    | undefined;
  let initializing: Promise<void> | undefined;
  const activate = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const cert = await readFile(config.OMNESIS_ACME_CERT_FILE, "utf8"),
      key = await readFile(publicKeyFile, "utf8");
    signal.throwIfAborted();
    await options.activate({ hostname: bindingOrigin(publicOrigin).hostname, cert, key }, signal);
    const certificate = new X509Certificate(cert);
    fingerprint = certificate.fingerprint256.replaceAll(":", "").toLowerCase();
    spkiFingerprint = publicKeyFingerprint(certificate.publicKey);
  };
  const initialize = (): Promise<void> =>
    (initializing ??= (async () => {
      let localDns: AcmeDnsChallenges | undefined;
      try {
        await ensureAcmeBootstrap({
          publicOrigin: publicOrigin,
          certificateFile: config.OMNESIS_ACME_CERT_FILE,
          privateKeyFile: publicKeyFile,
          generatePrivateKey: true,
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        });
        const { GatewayAcmeRenewal, relayDnsPresenter } = await import("./acme-gateway.js");
        let presenter;
        if (config.OMNESIS_ACME_DNS_PROVIDER === "cloudflare") {
          if (
            !config.OMNESIS_ACME_DNS_ZONE_ID ||
            !config.OMNESIS_ACME_DNS_ZONE_NAME ||
            !config.OMNESIS_ACME_DNS_TOKEN_FILE
          )
            throw new Error("Gateway-owned DNS requires a zone and private token file");
          const { token } = z
            .object({ token: z.string().min(1).max(8192) })
            .parse(await readPrivateJson(config.OMNESIS_ACME_DNS_TOKEN_FILE));
          const owner = await prepareGatewayOwner(keyOptions);
          const hostname = bindingOrigin(publicOrigin).hostname;
          localDns = await AcmeDnsChallenges.open({
            file: `${accountKeyFile}.dns-journal`,
            suffix: config.OMNESIS_ACME_DNS_ZONE_NAME,
            allowApex: true,
            provider: cloudflareDnsProvider({
              zoneId: config.OMNESIS_ACME_DNS_ZONE_ID,
              zoneName: config.OMNESIS_ACME_DNS_ZONE_NAME,
              token,
              fetch: options.fetch,
            }),
          });
          presenter = {
            create: (value: string, signal: AbortSignal) =>
              localDns!.create(owner.accountId, hostname, value, signal),
            // Cleanup owns a fresh bounded deadline even when issuance was cancelled.
            remove: (id: string) => localDns!.remove(owner.accountId, id),
          };
        } else if (config.OMNESIS_ACME_DNS_PROVIDER === "independent")
          presenter = independentDnsPresenter({
            brokerUrl: config.OMNESIS_ACME_DNS_BROKER_URL!,
            gateway: keyOptions,
            fetch: options.fetch,
          });
        else {
          const session = gatewayKeySessionSource(keyOptions);
          presenter = relayDnsPresenter({
            relayUrl: config.OMNESIS_CLOUD_RELAY_URL,
            session,
            invalidateSession: session.invalidate,
            fetch: options.fetch,
          });
        }
        await activate(abort.signal);
        state = {
          dns: localDns,
          renewal: new GatewayAcmeRenewal({
            directoryUrl: config.OMNESIS_ACME_DIRECTORY_URL,
            publicOrigin: publicOrigin,
            certificateFile: config.OMNESIS_ACME_CERT_FILE,
            privateKeyFile: publicKeyFile,
            accountKeyFile,
            presenter,
            issuer: options.issuer,
            trustedRoots: options.trustedRoots,
            activate,
            afterActivation: async (signal) => {
              await registerGatewayKey({ ...keyOptions, signal });
            },
          }),
        };
      } catch (error) {
        await localDns?.close().catch(() => {});
        throw error;
      }
    })().finally(() => {
      initializing = undefined;
    }));
  try {
    await initialize();
  } catch {
    createLogger("gateway:tls").warn(
      "Public ACME setup is unavailable; direct TLS remains active and the renewal task will retry",
    );
  }
  let pending: Promise<boolean> | undefined;
  return {
    fingerprintSha256: () => fingerprint,
    spkiFingerprintSha256: () => spkiFingerprint,
    renew(signal) {
      return (pending ??= (async () => {
        const combined = AbortSignal.any([signal, abort.signal]);
        combined.throwIfAborted();
        if (!state) await initialize();
        await ensureAcmeBootstrap({
          publicOrigin: publicOrigin,
          certificateFile: config.OMNESIS_ACME_CERT_FILE,
          privateKeyFile: publicKeyFile,
          generatePrivateKey: true,
          signal: combined,
        });
        const current = new X509Certificate(
          await readFile(config.OMNESIS_ACME_CERT_FILE),
        ).fingerprint256
          .replaceAll(":", "")
          .toLowerCase();
        if (current !== fingerprint) await activate(combined);
        // Enroll/migrate the current bootstrap before issuing a different leaf, including with gateway-owned DNS.
        await registerGatewayKey({ ...keyOptions, signal: combined });
        return state!.renewal.renew(combined);
      })().finally(() => {
        pending = undefined;
      }));
    },
    async close() {
      abort.abort();
      try {
        await pending?.catch(() => {});
      } finally {
        await state?.dns?.close();
      }
    },
  };
}
