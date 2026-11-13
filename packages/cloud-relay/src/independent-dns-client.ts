// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createReadStream } from "node:fs";
import { createPrivateKey, createPublicKey, sign, X509Certificate } from "node:crypto";
import { z } from "zod";
import { challengeIsFresh, relayOrigin } from "./network.js";
import { readBoundedJson } from "./google-credentials.js";
import {
  readOrCreateGatewayOwnerKey,
  type GatewayKeySessionOptions,
} from "./gateway-key-client.js";
import {
  publicKeyFingerprint,
  tlsKeySignatureAlgorithm,
  validateKeyRegistration,
} from "./gateway-key-auth.js";
import { readGatewayRecoveryReceipt } from "./gateway-recovery.js";
import {
  independentDnsRequestSchema,
  independentDnsOperationSchema,
  independentDnsChallengeSchema,
  independentDnsRequestDigest,
  independentDnsTranscript,
} from "./independent-dns-contract.js";
import type { AcmeDnsPresenter } from "./acme-client.js";

async function keyText(path: string): Promise<string> {
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > 65_536) throw new Error("Gateway DNS signing material is too large");
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts).toString("utf8");
}

/** The gateway talks directly to a separately operated DNS broker; no relay HMAC or provider token is accepted/sent. */
export function independentDnsPresenter(options: {
  brokerUrl: string;
  gateway: GatewayKeySessionOptions;
  fetch?: typeof fetch;
}): AcmeDnsPresenter {
  const broker = relayOrigin(options.brokerUrl);
  const request = async (
    operation: z.infer<typeof independentDnsOperationSchema>,
    caller: AbortSignal,
  ): Promise<unknown> => {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(15_000)]);
    signal.throwIfAborted();
    independentDnsOperationSchema.parse(operation);
    const gateway = options.gateway;
    const owner = await readOrCreateGatewayOwnerKey(
      gateway.ownerKeyFile ?? `${gateway.sessionFile}.owner-key`,
      false,
    );
    const tls = createPrivateKey(await keyText(gateway.privateKeyFile));
    const leaf = new X509Certificate(await keyText(gateway.certificateFile));
    if (publicKeyFingerprint(createPublicKey(tls)) !== publicKeyFingerprint(leaf.publicKey))
      throw new Error("Gateway DNS certificate and key do not match");
    const registration = validateKeyRegistration({
      gatewayId: gateway.gatewayId,
      publicOrigin: gateway.publicOrigin,
      certificate: leaf.toString(),
      ownerPublicKey: createPublicKey(owner).export({ type: "spki", format: "pem" }).toString(),
    });
    const recoveryReceipt = await readGatewayRecoveryReceipt(gateway, registration);
    if (!recoveryReceipt)
      throw new Error("Independent DNS requires an existing signed recovery receipt");
    const input = independentDnsRequestSchema.parse({ registration, recoveryReceipt, operation });
    const post = async (path: string, body: unknown) => {
      signal.throwIfAborted();
      const response = await (options.fetch ?? fetch)(new URL(path, broker), {
        method: "POST",
        headers: { "content-type": "application/json" },
        redirect: "error",
        signal,
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("Independent DNS broker refused the gateway operation");
      const value = await readBoundedJson(response);
      signal.throwIfAborted();
      return value;
    };
    const challenge = independentDnsChallengeSchema.parse(await post("/_dns/v1/challenge", input));
    if (
      challenge.brokerOrigin !== broker.origin ||
      challenge.requestDigest !== independentDnsRequestDigest(input) ||
      !challengeIsFresh(challenge.expiresAt)
    )
      throw new Error("Independent DNS challenge does not match this operation");
    return post("/_dns/v1/complete", {
      challengeId: challenge.challengeId,
      ownerSignature: sign(null, independentDnsTranscript(challenge, "owner"), owner).toString(
        "base64url",
      ),
      tlsSignature: sign(
        tlsKeySignatureAlgorithm(tls),
        independentDnsTranscript(challenge, "tls"),
        tls,
      ).toString("base64url"),
    });
  };
  return {
    async create(value, signal) {
      return z
        .object({ id: z.string().uuid(), expiresAt: z.number().int().positive() })
        .strict()
        .parse(await request({ type: "create", value }, signal));
    },
    async remove(leaseId) {
      // Cleanup has its own bounded lifetime even after issuance cancellation.
      z.object({ removed: z.literal(true) })
        .strict()
        .parse(await request({ type: "remove", leaseId }, AbortSignal.timeout(15_000)));
    },
  };
}
