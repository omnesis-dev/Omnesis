// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Passphrase-sealed string envelopes — the shared crypto core for every
 * "seal a small secret under a human-held passphrase" surface: the root-key
 * recovery escrow (`recovery-envelope.ts`) and the headless `passphrase`
 * secret-store backend.
 *
 * Scheme: scrypt (fixed v1 cost parameters) derives a KEK from the passphrase,
 * AES-256-GCM seals the value. The envelope's `omnesis` marker plus an optional
 * associated-data scope ride as GCM AAD, so envelopes cannot be swapped across
 * protocols (a recovery escrow is not a store entry) or across scopes (one
 * store entry cannot be renamed into another).
 *
 * Deriving the KEK costs on the order of a hundred milliseconds of CPU on a fast
 * host. Each operation therefore has an asynchronous twin that runs scrypt on
 * the libuv thread pool; code on an event loop that serves anything else uses
 * the twin, and the synchronous form is for callers that cannot await.
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt, scryptSync } from "node:crypto";

const ENVELOPE_VERSION = 1;
const ALG = "aes-256-gcm";
const KDF = "scrypt";

// v1 pins the KDF cost. The parameters still travel in the envelope for
// forward compatibility, but v1 readers reject anything else — trusting
// attacker-supplied n/r/p would let a crafted envelope pin a CPU for hours
// in scrypt before the GCM tag is ever checked.
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

const KEK_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedEnvelopeV1 {
  omnesis: string;
  version: typeof ENVELOPE_VERSION;
  alg: typeof ALG;
  kdf: typeof KDF;
  n: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class SealedEnvelopeInvalidError extends Error {
  readonly code = "OMNESIS_SEALED_ENVELOPE_INVALID";

  constructor() {
    super("The passphrase is incorrect or the sealed envelope is corrupt.");
    this.name = "SealedEnvelopeInvalidError";
  }
}

export interface SealedEnvelopeScope {
  /** Protocol marker stored as the envelope's `omnesis` field. */
  marker: string;
  /**
   * Extra associated data bound into the GCM AAD (e.g. the secret's name).
   * Omitted for protocols where the marker alone is the full scope.
   */
  aad?: string;
}

/** Seal a UTF-8 string under a passphrase-derived KEK. The passphrase is used verbatim. */
export function sealStringEnvelope(
  value: string,
  passphrase: string,
  scope: SealedEnvelopeScope,
): SealedEnvelopeV1 {
  const salt = randomBytes(SALT_BYTES);
  return sealWithKek(value, salt, deriveKek(passphrase, salt), scope);
}

/** {@link sealStringEnvelope}, with the KEK derived off the event loop. */
export async function sealStringEnvelopeAsync(
  value: string,
  passphrase: string,
  scope: SealedEnvelopeScope,
): Promise<SealedEnvelopeV1> {
  const salt = randomBytes(SALT_BYTES);
  return sealWithKek(value, salt, await deriveKekAsync(passphrase, salt), scope);
}

/** Seal under a derived KEK, and wipe it. */
function sealWithKek(
  value: string,
  salt: Buffer,
  kek: Buffer,
  scope: SealedEnvelopeScope,
): SealedEnvelopeV1 {
  const iv = randomBytes(IV_BYTES);
  try {
    const cipher = createCipheriv(ALG, kek, iv);
    cipher.setAAD(aadBytes(scope));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      omnesis: scope.marker,
      version: ENVELOPE_VERSION,
      alg: ALG,
      kdf: KDF,
      n: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      salt: salt.toString("base64url"),
      iv: iv.toString("base64url"),
      tag: tag.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
  } finally {
    kek.fill(0);
  }
}

/**
 * Parse and shape-validate a serialized envelope for a given marker WITHOUT
 * the passphrase. Returns the typed envelope or `null` when the input is not a
 * well-formed v1 envelope for that marker; never runs the KDF.
 */
export function parseSealedEnvelope(raw: unknown, marker: string): SealedEnvelopeV1 | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (
    e.omnesis !== marker ||
    e.version !== ENVELOPE_VERSION ||
    e.alg !== ALG ||
    e.kdf !== KDF ||
    e.n !== SCRYPT_N ||
    e.r !== SCRYPT_R ||
    e.p !== SCRYPT_P ||
    typeof e.salt !== "string" ||
    typeof e.iv !== "string" ||
    typeof e.tag !== "string" ||
    typeof e.ciphertext !== "string"
  ) {
    return null;
  }
  return {
    omnesis: marker,
    version: ENVELOPE_VERSION,
    alg: ALG,
    kdf: KDF,
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: e.salt,
    iv: e.iv,
    tag: e.tag,
    ciphertext: e.ciphertext,
  };
}

/**
 * Recover the sealed string. Throws {@link SealedEnvelopeInvalidError} when the
 * envelope is malformed, carries out-of-spec KDF parameters, was tampered with,
 * or the passphrase is wrong (GCM auth failure).
 */
export function openStringEnvelope(
  envelope: unknown,
  passphrase: string,
  scope: SealedEnvelopeScope,
): string {
  const parsed = parseSealedEnvelope(envelope, scope.marker);
  if (!parsed) throw new SealedEnvelopeInvalidError();
  return openWithKek(parsed, deriveKek(passphrase, Buffer.from(parsed.salt, "base64url")), scope);
}

/** {@link openStringEnvelope}, with the KEK derived off the event loop. */
export async function openStringEnvelopeAsync(
  envelope: unknown,
  passphrase: string,
  scope: SealedEnvelopeScope,
): Promise<string> {
  const parsed = parseSealedEnvelope(envelope, scope.marker);
  if (!parsed) throw new SealedEnvelopeInvalidError();
  const kek = await deriveKekAsync(passphrase, Buffer.from(parsed.salt, "base64url"));
  return openWithKek(parsed, kek, scope);
}

/** Open under a derived KEK, and wipe it. */
function openWithKek(parsed: SealedEnvelopeV1, kek: Buffer, scope: SealedEnvelopeScope): string {
  try {
    const decipher = createDecipheriv(ALG, kek, Buffer.from(parsed.iv, "base64url"), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aadBytes(scope));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SealedEnvelopeInvalidError();
  } finally {
    kek.fill(0);
  }
}

const SCRYPT_OPTIONS = {
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  // maxmem must exceed 128 * N * r; give generous headroom.
  maxmem: 256 * 1024 * 1024,
};

function deriveKek(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEK_BYTES, SCRYPT_OPTIONS);
}

function deriveKekAsync(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, KEK_BYTES, SCRYPT_OPTIONS, (err, kek) =>
      err ? reject(err) : resolve(kek),
    );
  });
}

function aadBytes(scope: SealedEnvelopeScope): Buffer {
  return Buffer.from(
    scope.aad === undefined ? scope.marker : `${scope.marker}:${scope.aad}`,
    "utf8",
  );
}
