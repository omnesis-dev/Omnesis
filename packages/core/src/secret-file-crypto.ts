// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, webcrypto } from "node:crypto";

const ENVELOPE_MARKER = "omnesis.secret-file";
const ENVELOPE_VERSION = 1;
const ALG = "aes-256-gcm";
const KDF = "hkdf-sha256";
const TAG_BYTES = 16;

interface SecretFileEnvelopeV1 {
  omnesis: typeof ENVELOPE_MARKER;
  version: typeof ENVELOPE_VERSION;
  alg: typeof ALG;
  kdf: typeof KDF;
  scope: string;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export function encryptEnvelope(plaintext: string, rootKey: Buffer, scope: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(rootKey, salt, scope);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(Buffer.from(scope, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: SecretFileEnvelopeV1 = {
    omnesis: ENVELOPE_MARKER,
    version: ENVELOPE_VERSION,
    alg: ALG,
    kdf: KDF,
    scope,
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function decryptEnvelope(
  envelope: SecretFileEnvelopeV1,
  rootKey: Buffer,
  scope: string,
): string {
  if (envelope.scope !== scope) {
    throw new Error(`Encrypted secret scope mismatch: expected ${scope}, got ${envelope.scope}`);
  }
  const salt = Buffer.from(envelope.salt, "base64url");
  const iv = Buffer.from(envelope.iv, "base64url");
  const key = deriveKey(rootKey, salt, scope);
  const decipher = createDecipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(scope, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function deriveKey(rootKey: Buffer, salt: Buffer, scope: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      rootKey,
      salt,
      Buffer.from(`omnesis:${ENVELOPE_MARKER}:${scope}`, "utf8"),
      32,
    ),
  );
}

export function parseEnvelope(raw: string): SecretFileEnvelopeV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.omnesis !== ENVELOPE_MARKER || candidate.version !== ENVELOPE_VERSION) return null;
  if (candidate.alg !== ALG || candidate.kdf !== KDF) return null;
  for (const key of ["scope", "salt", "iv", "tag"]) {
    if (typeof candidate[key] !== "string" || candidate[key].length === 0) return null;
  }
  if (typeof candidate.ciphertext !== "string") return null;
  return candidate as unknown as SecretFileEnvelopeV1;
}

/** Async file paths keep bulk AES work off the gateway's main thread. */
export async function encryptEnvelopeAsync(
  plaintext: string,
  rootKey: Buffer,
  scope: string,
): Promise<string> {
  const salt = randomBytes(16),
    iv = randomBytes(12);
  const derived = deriveKey(rootKey, salt, scope);
  const bytes = Buffer.from(plaintext, "utf8");
  try {
    const key = await webcrypto.subtle.importKey(
      "raw",
      Uint8Array.from(derived),
      "AES-GCM",
      false,
      ["encrypt"],
    );
    const sealed = Buffer.from(
      await webcrypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: Uint8Array.from(iv),
          additionalData: Uint8Array.from(Buffer.from(scope)),
          tagLength: TAG_BYTES * 8,
        },
        key,
        Uint8Array.from(bytes),
      ),
    );
    const envelope: SecretFileEnvelopeV1 = {
      omnesis: ENVELOPE_MARKER,
      version: ENVELOPE_VERSION,
      alg: ALG,
      kdf: KDF,
      scope,
      salt: salt.toString("base64url"),
      iv: iv.toString("base64url"),
      tag: sealed.subarray(-TAG_BYTES).toString("base64url"),
      ciphertext: sealed.subarray(0, -TAG_BYTES).toString("base64url"),
    };
    return JSON.stringify(envelope, null, 2) + "\n";
  } finally {
    derived.fill(0);
    bytes.fill(0);
  }
}

export async function decryptEnvelopeAsync(
  envelope: SecretFileEnvelopeV1,
  rootKey: Buffer,
  scope: string,
): Promise<string> {
  if (envelope.scope !== scope)
    throw new Error(`Encrypted secret scope mismatch: expected ${scope}, got ${envelope.scope}`);
  const derived = deriveKey(rootKey, Buffer.from(envelope.salt, "base64url"), scope);
  try {
    const key = await webcrypto.subtle.importKey(
      "raw",
      Uint8Array.from(derived),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const bytes = Buffer.from(
      await webcrypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Uint8Array.from(Buffer.from(envelope.iv, "base64url")),
          additionalData: Uint8Array.from(Buffer.from(scope)),
          tagLength: TAG_BYTES * 8,
        },
        key,
        Uint8Array.from(
          Buffer.concat([
            Buffer.from(envelope.ciphertext, "base64url"),
            Buffer.from(envelope.tag, "base64url"),
          ]),
        ),
      ),
    );
    try {
      return bytes.toString("utf8");
    } finally {
      bytes.fill(0);
    }
  } finally {
    derived.fill(0);
  }
}
