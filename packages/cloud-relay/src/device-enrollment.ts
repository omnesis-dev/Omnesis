// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

/**
 * Wire contract for sign-in enrollment. See docs/device-enrollment.md.
 *
 * Every transcript is a JSON array of ASCII strings: names are hashed first so
 * no platform's JSON escaping can change a digest. iOS, Android and the portal
 * reproduce these functions and share the vectors in device-enrollment.test.ts.
 */
const base64url = /^[A-Za-z0-9_-]+$/;
export const enrollmentOpaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const devicePublicKeySchema = z.string().min(64).max(256).regex(base64url);
export const deviceSignatureSchema = z.string().min(64).max(256).regex(base64url);
export const deviceKindSchema = z.enum(["ios", "android", "collector", "cli", "portal"]);

const sha256 = (value: Buffer | string): Buffer => createHash("sha256").update(value).digest();
const hex = (value: Buffer | string): string => sha256(value).toString("hex");
const digestUrl = (transcript: readonly string[]): string =>
  sha256(JSON.stringify(transcript)).toString("base64url");

/** SHA-256 of the DER SubjectPublicKeyInfo, used wherever a device key is named. */
export function deviceKeyThumbprint(devicePublicKey: string): string {
  return hex(Buffer.from(devicePublicKey, "base64url"));
}

export interface EnrollmentIdentity {
  requestId: string;
  kind: z.infer<typeof deviceKindSchema>;
  name: string;
  secret: string;
  devicePublicKey: string;
}

/** The one value a sign-in commits to: it names this request and this device key. */
export function enrollmentNonce(value: EnrollmentIdentity): string {
  return digestUrl([
    "omnesis-device-enrollment-v3",
    value.requestId,
    value.kind,
    hex(value.name),
    hex(value.secret),
    deviceKeyThumbprint(value.devicePublicKey),
  ]);
}

/** Google's `nonce` claim. The salt keeps one enrollment nonce from reusing a token across operations. */
export function googleProofNonce(salt: string, nonce: string): string {
  return digestUrl(["omnesis-google-proof-v3", salt, nonce]);
}

/** A WebAuthn challenge the gateway can recompute. `issuedAt` is Unix seconds as a decimal string. */
export function passkeyProofChallenge(salt: string, issuedAt: string, nonce: string): string {
  return digestUrl(["omnesis-passkey-proof-v3", salt, issuedAt, nonce]);
}

/**
 * What a sign-in commits to when it vouches for a passkey added to its account: that passkey's
 * id and public key (base64url COSE), and nothing else.
 */
export function passkeyEndorsementNonce(credentialId: string, publicKey: string): string {
  return digestUrl(["omnesis-passkey-endorsement-v1", credentialId, publicKey]);
}

/**
 * The gateway's challenge is its commitment to the nonce behind a request's comparison code:
 * the gateway is bound to the nonce before the device reveals its secret, and reveals it after.
 */
export function pairingCodeCommitment(codeNonce: string): string {
  return digestUrl(["omnesis-pairing-code-commitment-v1", enrollmentOpaque.parse(codeNonce)]);
}

/** A comparison code as it is sent, shown and compared: six decimal digits in two groups. */
export const pairingCodeSchema = z.string().regex(/^[0-9]{3} [0-9]{3}$/);

/** The one formatter: typed or stored digits become `123 456`, anything else is not a code. */
export function formatPairingCode(input: string): string | undefined {
  const digits = input.replace(/[\s-]/g, "");
  return /^[0-9]{6}$/.test(digits) ? `${digits.slice(0, 3)} ${digits.slice(3)}` : undefined;
}

/**
 * The code a new device and an approving device compare. It names the gateway certificate the
 * device connected to, the request, the device's secret and the gateway's nonce. It is only six
 * digits because neither side can choose its part after learning the other's: the gateway
 * committed to `codeNonce` (`pairingCodeCommitment`) before the device sent `secret`.
 * The first six digest bytes, read as a big-endian integer, are reduced modulo one million.
 */
export function pairingComparisonCode(input: {
  requestId: string;
  secret: string;
  gatewayFingerprint: string;
  codeNonce: string;
}): string {
  const digest = sha256(
    JSON.stringify([
      "omnesis-pairing-code-v3",
      z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(input.gatewayFingerprint),
      input.requestId,
      hex(input.secret),
      enrollmentOpaque.parse(input.codeNonce),
    ]),
  );
  const digits = String(digest.readUIntBE(0, 6) % 1_000_000).padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export function enrollmentSignatureTranscript(input: {
  requestId: string;
  kind: string;
  name: string;
  gatewaySpkiFingerprint: string;
  challenge: string;
  devicePublicKey: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify([
      "omnesis-device-enrollment-signature-v3",
      input.requestId,
      input.kind,
      hex(input.name),
      input.gatewaySpkiFingerprint,
      input.challenge,
      deviceKeyThumbprint(input.devicePublicKey),
    ]),
  );
}

export function tokenRotationTranscript(input: {
  deviceId: string;
  gatewaySpkiFingerprint: string;
  challenge: string;
  devicePublicKey: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify([
      "omnesis-device-token-rotation-v1",
      input.deviceId,
      input.gatewaySpkiFingerprint,
      input.challenge,
      deviceKeyThumbprint(input.devicePublicKey),
    ]),
  );
}

/** Loads a device key, refusing anything other than the P-256 keys every platform can hold. */
export function parseDevicePublicKey(devicePublicKey: string): KeyObject {
  const parsed = devicePublicKeySchema.parse(devicePublicKey);
  const der = Buffer.from(parsed, "base64url");
  if (der.toString("base64url") !== parsed) throw new Error("Non-canonical device key encoding");
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("Device keys must be P-256");
  return key;
}

/** Accepts DER (native clients) and IEEE P1363 (WebCrypto) encodings of an ES256 signature. */
export function verifyDeviceSignature(
  devicePublicKey: string,
  transcript: Buffer,
  signature: string,
): boolean {
  try {
    const parsed = deviceSignatureSchema.parse(signature);
    const bytes = Buffer.from(parsed, "base64url");
    if (bytes.toString("base64url") !== parsed) return false;
    const key = parseDevicePublicKey(devicePublicKey);
    return verify(
      "sha256",
      transcript,
      { key, dsaEncoding: bytes.length === 64 ? "ieee-p1363" : "der" },
      bytes,
    );
  } catch {
    return false;
  }
}

export function signDeviceTranscript(key: KeyObject, transcript: Buffer): string {
  return sign("sha256", transcript, key).toString("base64url");
}

export const googleSignInProofSchema = z
  .object({
    type: z.literal("google"),
    idToken: z.string().min(1).max(16_384),
    salt: enrollmentOpaque,
  })
  .strict();

const encoded = z.string().min(1).max(65_536).regex(base64url);
export const passkeySignInProofSchema = z
  .object({
    type: z.literal("passkey"),
    salt: enrollmentOpaque,
    issuedAt: z.string().regex(/^[1-9][0-9]{9,10}$/),
    /** Offered by the relay. Only used when you choose to trust an unknown sign-in; pins take priority. */
    credentialPublicKey: encoded.optional(),
    credential: z
      .object({
        id: encoded.max(2048),
        rawId: encoded.max(2048),
        type: z.literal("public-key"),
        authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
        clientExtensionResults: z.object({}).passthrough(),
        response: z
          .object({
            clientDataJSON: encoded,
            authenticatorData: encoded,
            signature: encoded,
            userHandle: encoded.max(128),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const passkeyRegistrationProofSchema = z
  .object({
    type: z.literal("passkey-registration"),
    salt: enrollmentOpaque,
    issuedAt: z.string().regex(/^[1-9][0-9]{9,10}$/),
    credential: z
      .object({
        id: encoded.max(2048),
        rawId: encoded.max(2048),
        type: z.literal("public-key"),
        authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
        clientExtensionResults: z.object({}).passthrough(),
        response: z
          .object({
            clientDataJSON: encoded,
            attestationObject: encoded,
            transports: z.array(z.string().min(1).max(32)).max(8).optional(),
            authenticatorData: encoded.optional(),
            publicKey: encoded.optional(),
            publicKeyAlgorithm: z.number().int().optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const signInProofSchema = z.discriminatedUnion("type", [
  googleSignInProofSchema,
  passkeySignInProofSchema,
  passkeyRegistrationProofSchema,
]);
export type SignInProof = z.infer<typeof signInProofSchema>;

export const deviceKeyEvidenceSchema = z
  .object({
    publicKey: devicePublicKeySchema,
    challenge: enrollmentOpaque,
    signature: deviceSignatureSchema,
  })
  .strict();
export type DeviceKeyEvidence = z.infer<typeof deviceKeyEvidenceSchema>;
