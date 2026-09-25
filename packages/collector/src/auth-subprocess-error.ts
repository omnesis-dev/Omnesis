// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a flow that ended badly puts on the wire.
 *
 * Extracted from `auth-subprocess.ts` for the reason its emitters were: that
 * script runs a flow and calls `process.exit` at module load, so nothing in it
 * can be imported by a test.
 */

import {
  isCredentialPersistError,
  isMissingCredentialsError,
  redactSecrets,
  toErrorMessage,
  type AuthErrorCode,
} from "@omnesis/core";
import { AuthFailure } from "@omnesis/source-sdk";

/** The `error` event, as both entry points produce it. */
export interface AuthErrorPayload {
  type: "error";
  error: string;
  code?: AuthErrorCode;
  fileKey?: string;
  providerName?: string;
  /** What the operator could do about it, in the source's own words. */
  remedy?: string;
  /** How long to wait before trying again, when the platform said. */
  retryAfterMs?: number;
}

/**
 * Which application credential a provider needs, as its descriptor declares it.
 *
 * Passed in rather than read here so this stays a pure function of what it is
 * handed, and so the one caller that has a descriptor is the one that supplies
 * it.
 */
export interface CredentialRouting {
  fileKey: string;
  providerName: string;
}

/** Carry a typed failure code onto the wire vocabulary consumers switch over. */
function wireCode(code: AuthFailure["code"]): AuthErrorCode {
  // Every arm has a home except cancellation, which the wire has always
  // spelled differently.
  return code === "cancelled" ? "user-cancelled" : code;
}

/**
 * Classify whatever a flow threw.
 *
 * Both entry points reach the same errors. A provider calling a shared
 * credential helper throws `MissingCredentialsError` whether it was invoked
 * through the older `authFlow` or through `authenticate`, and a client routes
 * on the payload rather than on which entry point produced it — so classifying
 * in one place is what stops the typed path from being the one that loses the
 * credentials wizard.
 *
 * `missing-credentials` is the only code a client *acts* on rather than
 * reports, and to act it needs which credential file, for which provider. That
 * is declared on the descriptor, so it is filled in from `routing` rather than
 * asked of every provider that raises the code: a provider repeating what its
 * own descriptor already says is a second place for the two to disagree.
 *
 * Everything is redacted before it leaves, because the parent copies the
 * message onto the flow record and `GET /admin/auth-flows` hands every flow to
 * every admin caller. A provider that echoes its input must not leak it there.
 */
export function authErrorPayload(
  err: unknown,
  opts: { secretValues: string[]; routing?: CredentialRouting },
): AuthErrorPayload {
  const redact = (message: string): string => redactSecrets(message, opts.secretValues);
  if (err instanceof AuthFailure) {
    return {
      type: "error",
      code: wireCode(err.code),
      ...(err.code === "missing-credentials" && opts.routing ? opts.routing : {}),
      ...(err.remedy ? { remedy: redact(err.remedy) } : {}),
      ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
      error: redact(err.message),
    };
  }
  if (isMissingCredentialsError(err)) {
    return {
      type: "error",
      code: "missing-credentials",
      fileKey: err.fileKey,
      providerName: err.providerName,
      error: redact(err.message),
    };
  }
  // The provider authenticated but could not store the credential. Reported
  // distinctly so the client keeps the pasted value and offers a retry — for an
  // api key shown once at creation, telling the operator to fetch a new one is
  // not a recovery.
  if (isCredentialPersistError(err)) {
    return { type: "error", code: "credential-persist-failed", error: redact(err.message) };
  }
  return { type: "error", error: redact(toErrorMessage(err)) };
}
