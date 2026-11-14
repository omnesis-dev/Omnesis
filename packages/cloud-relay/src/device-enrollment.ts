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

/**
 * What a sign-in made on the relay's account page is for. A gateway accepts a sign-in proof only
 * for the purpose it is verifying, so one made for one purpose never stands in for another:
 *
 * - `device-enrollment`: a device joins a gateway (`/devices/account/request`). The nonce is the
 *   device's own `enrollmentNonce` (or a pairing nonce), committed to as it is, which is what the
 *   iOS and Android apps sign. Produced by the account browser's `device-enrollment` operations,
 *   the desktop and portal sign-ins, and native-app sign-ins.
 * - `gateway-link`: a gateway is linked to an account, by gateway sign-up or by the `owner-link`
 *   operation from its account page. Whoever starts one picks its nonce, so the proof commits to
 *   that nonce under this purpose's own label (`signInProofNonce`) and can never equal an
 *   enrollment nonce.
 *
 * A passkey's endorsement and countersignature commit to `passkeyEndorsementNonce` and
 * `passkeyCountersignatureNonce` and are verified only as such.
 */
export type SignInPurpose = "device-enrollment" | "gateway-link";

/** The value a sign-in for `purpose` commits to, given the nonce of the operation it was made for. */
export function signInProofNonce(purpose: SignInPurpose, nonce: string): string {
  return purpose === "gateway-link" ? digestUrl(["omnesis-gateway-link-proof-v1", nonce]) : nonce;
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

/** One sign-in of an account, as a pin and a listing name it. */
export type AccountSignIn =
  { type: "google"; id: string } | { type: "passkey"; id: string; publicKey: string };

/**
 * A fixed-size name for one sign-in: a Google subject digest, or a passkey id with its public key
 * (base64url COSE). A countersignature commits to these, so its size does not grow with the size
 * of each passkey's id and key, and a gateway remembers withdrawn sign-ins by them.
 */
export function signInDigest(signIn: AccountSignIn): string {
  return digestUrl(
    signIn.type === "google"
      ? ["omnesis-sign-in-v1", "google", signIn.id]
      : ["omnesis-sign-in-v1", "passkey", signIn.id, signIn.publicKey],
  );
}

/**
 * What a passkey added to an account signs about the account's other sign-ins: that they belong
 * to the same owner as it does. An endorsement runs from an existing sign-in to the new passkey;
 * this runs the other way, so a gateway that trusts only the new passkey can trust the rest.
 * `signIns` are their `signInDigest`s, in any order. The account id keeps it from saying anything
 * about another account.
 */
export function passkeyCountersignatureNonce(
  accountId: string,
  signIns: readonly string[],
): string {
  return digestUrl(["omnesis-passkey-countersignature-v2", accountId, ...[...signIns].sort()]);
}

/**
 * What a passkey assertion made on a gateway's own page (`gateway-passkey`) is for. Unlike a
 * sign-in made on the relay's account page, its challenge comes from a one-use value this gateway
 * issued, and the browser can only have produced it on the gateway's own origin:
 *
 * - `device-enrollment`: a device joins. The gateway value is the `/devices/account/challenge`
 *   the request answers; the binding is the device's `enrollmentNonce`.
 * - `approve-request`: a person approves a held request (`gatewayPasskeyApprovalBinding`).
 * - `pin-passkey`: the owner confirms that a passkey the account lists is theirs
 *   (`gatewayPasskeyPinBinding`).
 * - `step-up`: the owner confirms one administrative action (`gatewayPasskeyStepUpBinding`).
 */
export const gatewayPasskeyPurposeSchema = z.enum([
  "device-enrollment",
  "approve-request",
  "pin-passkey",
  "step-up",
]);
export type GatewayPasskeyPurpose = z.infer<typeof gatewayPasskeyPurposeSchema>;

/**
 * The WebAuthn challenge of a `gateway-passkey` assertion. It names the purpose, the gateway
 * origin the browser was on, the gateway's one-use value and what the assertion approves, so an
 * assertion made for one of these can never stand in for another.
 */
export function gatewayPasskeyChallenge(
  purpose: GatewayPasskeyPurpose,
  gatewayOrigin: string,
  gatewayChallenge: string,
  binding: string,
): string {
  return digestUrl([
    "omnesis-gateway-passkey-v1",
    gatewayPasskeyPurposeSchema.parse(purpose),
    gatewayOrigin,
    enrollmentOpaque.parse(gatewayChallenge),
    binding,
  ]);
}

/** What approving a held request commits to: that request, its device key and its code. */
export function gatewayPasskeyApprovalBinding(input: {
  requestId: string;
  devicePublicKey?: string;
  verificationCode: string;
}): string {
  return digestUrl([
    "omnesis-gateway-approval-v1",
    input.requestId,
    input.devicePublicKey ? deviceKeyThumbprint(input.devicePublicKey) : "",
    pairingCodeSchema.parse(input.verificationCode),
  ]);
}

/** What confirming a passkey commits to: this gateway and the account it is linked to. */
export function gatewayPasskeyPinBinding(input: { gatewayId: string; accountId: string }): string {
  return digestUrl(["omnesis-gateway-pin-v1", input.gatewayId.toLowerCase(), input.accountId]);
}

/**
 * What a step-up commits to: one request to the gateway, by the device making it. `bodySha256` is
 * the lowercase hex SHA-256 of the exact request body ("" hashed for none).
 */
export function gatewayPasskeyStepUpBinding(input: {
  method: string;
  path: string;
  bodySha256: string;
  deviceId: string;
}): string {
  return digestUrl([
    "omnesis-gateway-step-up-v1",
    input.method.toUpperCase(),
    input.path,
    z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(input.bodySha256),
    input.deviceId,
  ]);
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
const passkeyAssertionSchema = z
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
  .strict();
export const passkeySignInProofSchema = z
  .object({
    type: z.literal("passkey"),
    salt: enrollmentOpaque,
    issuedAt: z.string().regex(/^[1-9][0-9]{9,10}$/),
    /** Offered by the relay. Only used when you choose to trust an unknown sign-in; pins take priority. */
    credentialPublicKey: encoded.optional(),
    credential: passkeyAssertionSchema,
  })
  .strict();

/**
 * A passkey assertion made on the gateway's own page, over `gatewayPasskeyChallenge`. It carries
 * no salt and no time: `challenge` is the one-use value the gateway issued, which the gateway
 * spends when it checks the assertion, so the assertion can't be kept for later. The key it is
 * checked against is one the owner confirmed on this gateway, never one that arrives with it.
 */
export const gatewayPasskeySignInProofSchema = z
  .object({
    type: z.literal("gateway-passkey"),
    challenge: enrollmentOpaque,
    credential: passkeyAssertionSchema,
  })
  .strict();
export type GatewayPasskeySignInProof = z.infer<typeof gatewayPasskeySignInProofSchema>;

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

/**
 * A passkey's own signature, made while it was being added, over the sign-ins its account
 * already had (`passkeyCountersignatureNonce`). The relay keeps it beside the passkey.
 */
export const passkeyCountersignatureSchema = z
  .object({
    proof: passkeySignInProofSchema,
    /** `signInDigest` of each sign-in the account had; an account holds at most 16. */
    signIns: z.array(enrollmentOpaque).max(64),
  })
  .strict();
export type PasskeyCountersignature = z.infer<typeof passkeyCountersignatureSchema>;

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

/**
 * What a device's request to join may carry: a sign-in made on the relay's account page or in an
 * app, or a passkey assertion made on the gateway's own page.
 */
export const enrollmentProofSchema = z.discriminatedUnion("type", [
  googleSignInProofSchema,
  passkeySignInProofSchema,
  passkeyRegistrationProofSchema,
  gatewayPasskeySignInProofSchema,
]);
export type EnrollmentProof = z.infer<typeof enrollmentProofSchema>;
