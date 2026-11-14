// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The DNS broker's wire contract (version 2). It runs unchanged on Node (the gateway, tests and
 * the local broker) and in a Cloudflare Worker, so it uses only zod and the Web platform: no
 * `node:` module may be imported here, directly or through another file.
 */
import { z } from "zod";

export const DNS_BROKER_PROTOCOL = "omnesis-dns-broker-v2";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32-byte key follows. */
const ED25519_SPKI_PREFIX = [
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Decodes canonical, unpadded base64url only. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1)
    throw new Error("Invalid base64url text");
  const binary = atob(
    text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4),
  );
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64url(bytes) !== text) throw new Error("Invalid base64url text");
  return bytes;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The same label as `hostedGatewayLabel`, computed with Web Crypto. */
export async function hostedLabel(gatewayId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(gatewayId.toLowerCase())),
  );
  const head = digest.slice(0, 5).reduce((value, byte) => value * 256 + byte, 0);
  let label = "g-";
  for (let index = 0; index < 8; index++)
    label += BASE32[Math.floor(head / 2 ** (35 - 5 * index)) & 31];
  return label;
}

const domainSchema = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/);
export const brokerHostnameSchema = domainSchema;
export const relayDomainSchema = domainSchema;
const gatewayIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
/** The owner's Ed25519 public key as unpadded base64url DER SubjectPublicKeyInfo. */
export const ownerPublicKeySchema = z
  .string()
  .length(59)
  .refine((value) => {
    try {
      const der = fromBase64url(value);
      return der.length === 44 && ED25519_SPKI_PREFIX.every((byte, index) => der[index] === byte);
    } catch {
      return false;
    }
  }, "An Ed25519 public key is required");
export const acmeChallengeValueSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/**
 * An ACME account URL as RFC 8657 puts it in a CAA `accounturi` parameter: no character that
 * could end the parameter or the property value.
 */
export const accountUriSchema = z
  .string()
  .max(512)
  .regex(/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?\/[A-Za-z0-9/._~-]*$/);

export const brokerOperationSchema = z.discriminatedUnion("type", [
  /** Binds the name to this owner key, on first use only. */
  z.object({ type: z.literal("claim") }).strict(),
  z.object({ type: z.literal("txt-create"), value: acmeChallengeValueSchema }).strict(),
  z.object({ type: z.literal("txt-remove"), leaseId: z.string().uuid() }).strict(),
  /** Publishes the name's CAA record bound to this ACME account, with explicit A/AAAA records. */
  z.object({ type: z.literal("caa"), accountUri: accountUriSchema }).strict(),
  /** Removes the name's records. The name stays bound to its owner key. */
  z.object({ type: z.literal("release") }).strict(),
]);
export type BrokerOperation = z.infer<typeof brokerOperationSchema>;

export const brokerRequestSchema = z
  .object({
    hostname: brokerHostnameSchema,
    gatewayId: gatewayIdSchema,
    ownerPublicKey: ownerPublicKeySchema,
    operation: brokerOperationSchema,
  })
  .strict();
export type BrokerRequest = z.infer<typeof brokerRequestSchema>;

export const brokerChallengeSchema = z
  .object({
    protocol: z.literal(DNS_BROKER_PROTOCOL),
    brokerOrigin: z.string().min(1).max(2048),
    challengeId: z.string().uuid(),
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type BrokerChallenge = z.infer<typeof brokerChallengeSchema>;

export const brokerCompletionSchema = z
  .object({
    challengeId: z.string().uuid(),
    ownerSignature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();

export const brokerResultSchemas = {
  claim: z.object({ claimed: z.literal(true) }).strict(),
  "txt-create": z
    .object({ id: z.string().uuid(), expiresAt: z.number().int().positive() })
    .strict(),
  "txt-remove": z.object({ removed: z.literal(true) }).strict(),
  caa: z.object({ caa: z.literal(true) }).strict(),
  release: z.object({ released: z.literal(true) }).strict(),
} as const;

/** What a broker says about itself; the gateway checks it before using the broker at all. */
export const brokerHealthSchema = z
  .object({
    protocol: z.literal(DNS_BROKER_PROTOCOL),
    relayDomain: relayDomainSchema,
    caa: z.object({ issuer: domainSchema, accountUriPrefix: accountUriSchema }).strict(),
  })
  .strict();
export type BrokerHealth = z.infer<typeof brokerHealthSchema>;

/** One registry entry as the relay operator exports it for the broker's first import. */
export const registryEntrySchema = z
  .object({
    hostname: brokerHostnameSchema,
    gatewayId: gatewayIdSchema,
    ownerPublicKey: ownerPublicKeySchema,
  })
  .strict();
export const registryImportSchema = z
  .object({ entries: z.array(registryEntrySchema).max(1000) })
  .strict();
export type RegistryEntry = z.infer<typeof registryEntrySchema>;

function operationValue(operation: BrokerOperation): string | null {
  switch (operation.type) {
    case "txt-create":
      return operation.value;
    case "txt-remove":
      return operation.leaseId;
    case "caa":
      return operation.accountUri;
    default:
      return null;
  }
}

/** The name, identity and exact operation can't be swapped between challenge and completion. */
export function brokerRequestDigest(request: BrokerRequest): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      "omnesis-dns-broker-request-v2",
      request.hostname,
      request.gatewayId,
      request.ownerPublicKey,
      request.operation.type,
      operationValue(request.operation),
    ]),
  );
}

/** What the owner key signs: the broker, its one-use challenge and the request digest. */
export function brokerTranscript(challenge: BrokerChallenge): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify([
      "omnesis-dns-broker-proof-v2",
      challenge.protocol,
      challenge.brokerOrigin,
      challenge.challengeId,
      challenge.nonce,
      challenge.requestDigest,
      challenge.expiresAt,
    ]),
  );
}

export async function verifyOwnerSignature(
  ownerPublicKey: string,
  challenge: BrokerChallenge,
  signature: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      fromBase64url(ownerPublicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      fromBase64url(signature),
      brokerTranscript(challenge),
    );
  } catch {
    return false;
  }
}

/**
 * The CAA property a gateway's name carries: only this issuer, only DNS-01 and only this ACME
 * account may issue for it (RFC 8657).
 */
export function accountBoundCaaValue(issuer: string, accountUri: string): string {
  return `${issuer}; validationmethods=dns-01; accounturi=${accountUriSchema.parse(accountUri)}`;
}
