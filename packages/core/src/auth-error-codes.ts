// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Structured error codes shared by every auth-flow producer
 * (`MissingCredentialsError`, the auth subprocess's `error` event,
 * the gateway's `AuthFlowEvent.code`) and consumed by the CLI's
 * SSE stream reader. Adding a new code requires updating every
 * `switch` over `AuthErrorCode` so the compiler flags any unhandled arm.
 *
 * Codes:
 *   - `missing-credentials` — provider requires user-supplied OAuth
 *     credentials and none are on disk. Caller surfaces the setup
 *     wizard for that provider.
 *   - `user-cancelled` — the user invoked `auth.cancel` (or the
 *     consumer otherwise tore the subprocess down). Distinct from
 *     a generic error so UIs can suppress the "auth failed" prompt.
 *   - `timeout` — the consumer's inactivity watchdog fired (no NDJSON
 *     events from the subprocess for ~30 minutes). Hung-process signal.
 *   - `credential-persist-failed` — the provider authenticated, but could
 *     not store the credential for the account it resolved (locked keyring,
 *     unwritable config dir, no space). Distinct because the pasted value may
 *     be unrecoverable — an API key shown once at creation — so the client
 *     must keep what the user typed and offer a retry rather than sending them
 *     back to the platform for a fresh one.
 *   - `denied` — the user was asked and refused. Repeating the identical
 *     request is how a prompt becomes a loop, so this is not retryable by the
 *     same flow.
 *   - `challenge-expired` — something the user was shown went stale before
 *     they answered it: a rotating pairing code, an authorize URL with a
 *     deadline. Retryable, and the retry is what produces a fresh one.
 *   - `identity-mismatch` — the flow authenticated successfully, but as a
 *     different account than the one being renewed. The credential is good and
 *     belongs somewhere else; the account that was being fixed still is not.
 *   - `unsupported` — the platform will not do this here: wrong operating
 *     system, a native dependency that is absent. No amount of retrying helps.
 *   - `unavailable` — the platform could not be reached. The opposite of
 *     `denied`: nothing was refused, and later may work.
 *   - `credential-rejected` — the credential the operator supplied is not
 *     usable, whoever refused it: a wrong password or a revoked key, refused
 *     by the platform; or a key whose permissions are wider than the source
 *     will hold, a plan that does not include the API, a value that is not
 *     the shape the platform issues — refused by Omnesis. One code, because a
 *     client does the same thing with either: it asks again. Distinct from
 *     `denied`, which is a person refusing, and from `missing-credentials`,
 *     which is nothing to present. Retryable, because the retry is the
 *     operator supplying a different one.
 *   - `insecure-connection` — the transport could not be trusted: an expired
 *     or self-signed certificate, a name the certificate does not cover.
 *     Split out of `unavailable` because it never clears on its own, and a
 *     client that offers "try again" for it is sending the operator in a
 *     circle.
 *   - `duplicate` — the credential is good and leads to data already
 *     connected under another account. Nothing refused it; Omnesis declined
 *     to connect the same records twice.
 *   - `local-conflict` — something on the machine running the flow is in the
 *     way: the loopback port a redirect must land on is already taken.
 *     Retryable once the operator frees it, which is why it cannot be
 *     `unsupported`, and local, which is why it cannot be `unavailable`.
 *   - `unknown` — the subprocess exited (or its stdout closed) without
 *     ever emitting a terminal `complete` or `error` event. Catch-all
 *     for "we lost the child mid-flow" cases.
 */
export const AUTH_ERROR_CODES = [
  "missing-credentials",
  "credential-persist-failed",
  "user-cancelled",
  "timeout",
  "denied",
  "challenge-expired",
  "identity-mismatch",
  "unsupported",
  "unavailable",
  "credential-rejected",
  "insecure-connection",
  "duplicate",
  "local-conflict",
  "unknown",
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export function isAuthErrorCode(value: unknown): value is AuthErrorCode {
  return typeof value === "string" && (AUTH_ERROR_CODES as readonly string[]).includes(value);
}
