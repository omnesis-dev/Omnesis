// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import { accountId, type Identity } from "./identity.js";
import {
  bindingOrigin,
  gatewayBindingNonce,
  certificateFingerprint,
  validateCertificateDates,
  gatewayBindingSchema,
  type GatewayBinding,
} from "./gateway-binding.js";
import { RelayError } from "./tunnels.js";
import { relayOrigin } from "./network.js";

export const KEY_AUTH_ISSUER = "omnesis-gateway-owner-key-v2";
export const KEY_BINDING_PREFIX = "omnesis-owner-key-v2:";
export const keyRegistrationSchema = gatewayBindingSchema
  .omit({ identityToken: true })
  .extend({
    ownerPublicKey: z.string().min(1).max(1024),
  })
  .strict();
export type KeyRegistration = z.infer<typeof keyRegistrationSchema>;
export const keyChallengeRequestSchema = keyRegistrationSchema
  .extend({ relayOrigin: z.string().min(1).max(2048) })
  .strict();
export const keyChallengeSchema = z
  .object({
    challengeId: z.string().uuid(),
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive(),
    relayOrigin: z.string().min(1).max(2048),
  })
  .strict();
export type KeyChallenge = z.infer<typeof keyChallengeSchema>;
export const keyCompletionSchema = z
  .object({
    challengeId: z.string().uuid(),
    ownerSignature: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/),
    tlsSignature: z
      .string()
      .min(1)
      .max(16_384)
      .regex(/^[A-Za-z0-9_-]+$/),
    enrollmentToken: z.string().min(1).max(4096).optional(),
    recoveryReceipt: z.unknown().optional(),
  })
  .strict();

export function publicKeyFingerprint(key: KeyObject): string {
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
}

/** Signature algorithms are selected from the certified key, never from an untrusted algorithm field. */
export function tlsKeySignatureAlgorithm(
  key: Pick<KeyObject, "asymmetricKeyType" | "asymmetricKeyDetails">,
): string | null {
  const details = key.asymmetricKeyDetails;
  switch (key.asymmetricKeyType) {
    case "rsa":
    case "rsa-pss": {
      const algorithm = details?.hashAlgorithm ?? "sha256";
      const bits = details?.modulusLength ?? 0;
      if (bits < 2048 || bits > 8192 || !["sha256", "sha384", "sha512"].includes(algorithm))
        throw new Error("Unsupported TLS signing key strength");
      return algorithm;
    }
    case "ec":
      if (!["prime256v1", "secp384r1", "secp521r1"].includes(details?.namedCurve ?? ""))
        throw new Error("Unsupported TLS signing curve");
      return "sha256";
    case "ed25519":
    case "ed448":
      return null;
    default:
      throw new Error("Unsupported TLS signing key");
  }
}

export function validateKeyRegistration(input: unknown): KeyRegistration {
  const parsed = keyRegistrationSchema.parse(input);
  const certificate = new X509Certificate(parsed.certificate);
  const value = {
    ...parsed,
    gatewayId: parsed.gatewayId.toLowerCase(),
    publicOrigin: bindingOrigin(parsed.publicOrigin).origin,
    certificate: certificate.toString(),
  };
  // Reject bundles/private material before normalizing the public leaf.
  gatewayBindingNonce(parsed);
  validateCertificateDates(certificate);
  const owner = createPublicKey(parsed.ownerPublicKey);
  if (
    owner.asymmetricKeyType !== "ed25519" ||
    owner.export({ type: "spki", format: "pem" }).toString().trim() !== parsed.ownerPublicKey.trim()
  )
    throw new Error("A canonical public Ed25519 owner key is required");
  tlsKeySignatureAlgorithm(certificate.publicKey);
  if (publicKeyFingerprint(owner) === publicKeyFingerprint(certificate.publicKey))
    throw new Error("Owner and TLS identity keys must be distinct");
  return { ...value, ownerPublicKey: owner.export({ type: "spki", format: "pem" }).toString() };
}

export function gatewayKeyIdentity(
  value: Pick<KeyRegistration, "gatewayId" | "ownerPublicKey">,
  expiresAt: number,
): Identity {
  return {
    issuer: KEY_AUTH_ISSUER,
    subject: JSON.stringify([
      value.gatewayId.toLowerCase(),
      publicKeyFingerprint(createPublicKey(value.ownerPublicKey)),
    ]),
    expiresAt,
  };
}

export function keyBindingOwnerPublicKey(binding: GatewayBinding): string | undefined {
  if (!binding.identityToken.startsWith(KEY_BINDING_PREFIX)) return undefined;
  try {
    const encoded = binding.identityToken.slice(KEY_BINDING_PREFIX.length);
    const owner = createPublicKey({
      key: Buffer.from(encoded, "base64url"),
      type: "spki",
      format: "der",
    });
    if (
      owner.asymmetricKeyType !== "ed25519" ||
      owner.export({ type: "spki", format: "der" }).toString("base64url") !== encoded
    )
      return undefined;
    return owner.export({ type: "spki", format: "pem" }).toString();
  } catch {
    return undefined;
  }
}

export function keyBindingOwnerAccount(binding: GatewayBinding): string | undefined {
  const ownerPublicKey = keyBindingOwnerPublicKey(binding);
  return ownerPublicKey === undefined
    ? undefined
    : gatewayKeyAccount({ ...binding, ownerPublicKey });
}

export function gatewayKeyAccount(
  value: Pick<KeyRegistration, "gatewayId" | "ownerPublicKey">,
): string {
  return accountId(gatewayKeyIdentity(value, 1));
}

/** Owner and TLS signatures have separate purposes and bind every routing/key field and the relay's one-use challenge. */
export function keyAuthenticationTranscript(
  value: KeyRegistration,
  challenge: KeyChallenge,
  purpose: "owner" | "tls",
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "omnesis-gateway-key-auth-v2",
      purpose,
      value.gatewayId.toLowerCase(),
      bindingOrigin(value.publicOrigin).origin,
      certificateFingerprint(value.certificate),
      publicKeyFingerprint(createPublicKey(value.ownerPublicKey)),
      challenge.nonce,
      challenge.challengeId,
      challenge.expiresAt,
      relayOrigin(challenge.relayOrigin).origin,
    ]),
  );
}

interface Pending {
  registration: KeyRegistration;
  challenge: KeyChallenge;
}

/** Routing ownership needs no identity provider. The relay holds public keys and expiring challenges only. */
export class GatewayKeyAuthentication {
  private readonly pending = new Map<string, Pending>();
  constructor(
    private readonly options: {
      relayOrigin: string | (() => string);
      ttlMs?: number;
      maxPending?: number;
    },
  ) {
    if (
      !Number.isSafeInteger(options.ttlMs ?? 60_000) ||
      (options.ttlMs ?? 60_000) <= 0 ||
      (options.ttlMs ?? 60_000) > 60_000 ||
      !Number.isSafeInteger(options.maxPending ?? 32) ||
      (options.maxPending ?? 32) <= 0 ||
      (options.maxPending ?? 32) > 32
    )
      throw new Error("Invalid key authentication limits");
  }

  challenge(input: unknown): KeyChallenge {
    this.prune();
    if (this.pending.size >= (this.options.maxPending ?? 32))
      throw new RelayError(429, "Key challenge capacity reached");
    const { relayOrigin: recipient, ...fields } = keyChallengeRequestSchema.parse(input);
    const origin = relayOrigin(
      typeof this.options.relayOrigin === "string"
        ? this.options.relayOrigin
        : this.options.relayOrigin(),
    ).origin;
    if (relayOrigin(recipient).origin !== origin)
      throw new RelayError(400, "Wrong key proof recipient");
    const registration = validateKeyRegistration(fields);
    const challenge = {
      challengeId: randomUUID(),
      nonce: randomBytes(32).toString("hex"),
      relayOrigin: origin,
      expiresAt: Date.now() + (this.options.ttlMs ?? 60_000),
    };
    this.pending.set(challenge.challengeId, { registration, challenge });
    return { ...challenge };
  }

  complete(input: unknown): {
    binding: GatewayBinding;
    identity: Identity;
    registration: KeyRegistration;
  } {
    const value = keyCompletionSchema.parse(input);
    this.prune();
    const row = this.pending.get(value.challengeId);
    if (!row) throw new RelayError(401, "Key challenge is missing or expired");
    this.pending.delete(value.challengeId);
    validateKeyRegistration(row.registration);
    const owner = createPublicKey(row.registration.ownerPublicKey);
    const tls = new X509Certificate(row.registration.certificate).publicKey;
    if (
      !verify(
        null,
        keyAuthenticationTranscript(row.registration, row.challenge, "owner"),
        owner,
        Buffer.from(value.ownerSignature, "base64url"),
      ) ||
      !verify(
        tlsKeySignatureAlgorithm(tls),
        keyAuthenticationTranscript(row.registration, row.challenge, "tls"),
        tls,
        Buffer.from(value.tlsSignature, "base64url"),
      )
    )
      throw new RelayError(401, "Gateway key possession was not proven");
    return {
      registration: row.registration,
      binding: {
        gatewayId: row.registration.gatewayId,
        publicOrigin: row.registration.publicOrigin,
        certificate: row.registration.certificate,
        identityToken:
          KEY_BINDING_PREFIX + owner.export({ type: "spki", format: "der" }).toString("base64url"),
      },
      identity: gatewayKeyIdentity(row.registration, Math.floor(Date.now() / 1000) + 3600),
    };
  }

  private prune(): void {
    for (const [id, row] of this.pending)
      if (row.challenge.expiresAt <= Date.now()) this.pending.delete(id);
  }
}
