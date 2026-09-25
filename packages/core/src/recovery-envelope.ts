// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Root-key recovery escrow.
 *
 * `omnesis keyring export-recovery` seals the install root key under a
 * printable recovery code so the encrypted stores (and every encrypted backup)
 * survive a lost OS keyring. The envelope is safe to keep alongside backups:
 * opening it requires the recovery code, which is never stored.
 *
 * The sealing scheme (scrypt KEK + AES-256-GCM with the protocol marker as
 * AAD) lives in `sealed-envelope.ts`; this module owns the recovery-specific
 * pieces — code generation/normalization and the pinned `omnesis.recovery-key`
 * protocol marker.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  openStringEnvelope,
  parseSealedEnvelope,
  sealStringEnvelope,
  SealedEnvelopeInvalidError,
  type SealedEnvelopeV1,
} from "./sealed-envelope.js";

const ENVELOPE_MARKER = "omnesis.recovery-key";
const RECOVERY_ENVELOPE_FILE = "recovery-envelope.json";
const RECOVERY_CODE_BYTES = 20; // 160 bits of entropy

// Crockford base32 alphabet (no I, L, O, U — avoids transcription ambiguity).
const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Canonical location of the root-key recovery envelope inside a config dir.
 * The writer (`omnesis keyring export-recovery`), the doctor's escrow
 * inspection, and the backup bundler all resolve the path through here so
 * there is a single on-disk contract.
 */
export function recoveryEnvelopePath(dir: string): string {
  return join(dir, "keyring", RECOVERY_ENVELOPE_FILE);
}

export interface RecoveryEnvelopeV1 extends SealedEnvelopeV1 {
  omnesis: typeof ENVELOPE_MARKER;
}

export class RecoveryCodeInvalidError extends Error {
  readonly code = "OMNESIS_RECOVERY_CODE_INVALID";

  constructor() {
    super("Recovery code is incorrect or the recovery envelope is corrupt.");
    this.name = "RecoveryCodeInvalidError";
  }
}

/**
 * Generate a high-entropy printable recovery code grouped for transcription
 * (e.g. `H2M9-4KQ7-…`), carrying ~160 bits of entropy.
 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_BYTES);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return (out.match(/.{1,4}/g) ?? []).join("-");
}

/**
 * Normalize a user-entered recovery code: strip separators/whitespace and
 * upper-case, so it matches regardless of how the operator retyped it.
 */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

/** Wrap the install root key value under a recovery-code-derived KEK. */
export function createRecoveryEnvelope(
  rootKeyValue: string,
  recoveryCode: string,
): RecoveryEnvelopeV1 {
  return sealStringEnvelope(rootKeyValue, normalizeRecoveryCode(recoveryCode), {
    marker: ENVELOPE_MARKER,
  }) as RecoveryEnvelopeV1;
}

/**
 * Parse and shape-validate a serialized recovery envelope WITHOUT the recovery
 * code, returning the typed envelope or `null` if the input is not a well-formed
 * v1 escrow. Inspection surfaces (e.g. `omnesis doctor`) use this to
 * report whether an escrow exists and is intact; it never attempts decryption
 * and the recovery code is not involved.
 *
 * v1 pins the KDF cost parameters, so a well-formed envelope must carry exactly
 * those values — see `sealed-envelope.ts` for why trusting attacker-supplied
 * parameters is unsafe.
 */
export function parseRecoveryEnvelope(raw: unknown): RecoveryEnvelopeV1 | null {
  return parseSealedEnvelope(raw, ENVELOPE_MARKER) as RecoveryEnvelopeV1 | null;
}

/**
 * Recover the install root key value from an envelope + recovery code. Throws
 * {@link RecoveryCodeInvalidError} if the code is wrong or the envelope was
 * tampered with (the GCM auth tag fails).
 */
export function openRecoveryEnvelope(envelope: RecoveryEnvelopeV1, recoveryCode: string): string {
  try {
    return openStringEnvelope(envelope, normalizeRecoveryCode(recoveryCode), {
      marker: ENVELOPE_MARKER,
    });
  } catch (err) {
    if (err instanceof SealedEnvelopeInvalidError) throw new RecoveryCodeInvalidError();
    throw err;
  }
}
