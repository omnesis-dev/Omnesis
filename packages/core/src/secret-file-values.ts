// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { installRootKeyBytes } from "./secret-store.js";
import { decryptEnvelopeAsync, encryptEnvelopeAsync, parseEnvelope } from "./secret-file-crypto.js";

interface ScopedSecretKey {
  rootKey: string;
  scope: string;
}
const MAX_VALUE_BYTES = 16 * 1024 * 1024;
function validate(value: string, scope: string): void {
  if (
    Buffer.byteLength(value) > MAX_VALUE_BYTES ||
    !scope ||
    Buffer.byteLength(scope) > 4096 ||
    scope.includes("\0")
  )
    throw new Error("Unsupported protected text");
}

/** Authenticate personal content in memory for a caller that must validate its schema before import. */
export async function openSecretFileValueAsync(
  raw: string,
  options: ScopedSecretKey,
): Promise<string> {
  let key: Buffer | undefined;
  try {
    validate(raw, options.scope);
    const envelope = parseEnvelope(raw);
    if (!envelope) throw new Error("An encrypted value is required");
    key = installRootKeyBytes(options.rootKey);
    return await decryptEnvelopeAsync(envelope, key, options.scope);
  } catch {
    throw new Error("The protected text could not be authenticated for this library");
  } finally {
    key?.fill(0);
  }
}

/** Return sealed bytes only; the caller owns atomic private publication. Neither key is installed. */
export async function sealSecretFileValueAsync(
  value: string,
  options: ScopedSecretKey,
): Promise<string> {
  let key: Buffer | undefined;
  try {
    validate(value, options.scope);
    key = installRootKeyBytes(options.rootKey);
    return await encryptEnvelopeAsync(value, key, options.scope);
  } catch {
    throw new Error("The personal content could not be protected for this library");
  } finally {
    key?.fill(0);
  }
}
