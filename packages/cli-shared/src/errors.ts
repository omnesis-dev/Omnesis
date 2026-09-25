// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Typed exit codes + structured CLI error class.
 *
 * Every CLI command path ends in either a clean return (exit 0) or a
 * thrown `CliError`. The shared runner wraps the dispatch and maps the
 * thrown class into a typed `process.exit(code)` so:
 *
 *   - Scripts can distinguish "user typo" (`EXIT_USER_ERROR`) from
 *     "gateway is down" (`EXIT_GATEWAY_DOWN`) from "permission denied"
 *     (`EXIT_AUTH`) without grep'ing stderr.
 *   - `withSpinner` callbacks throwing CliError unwind cleanly — the
 *     spinner's `try/catch` runs `spin.error(...)` before re-throwing,
 *     so terminal state never gets corrupted.
 *
 * Adding a new exit code: add it here and document it in the
 * `omnesis --help` output.
 */

export const EXIT_OK = 0;
/** Generic failure (no other code applies). */
export const EXIT_FAILURE = 1;
/** User-supplied input was malformed (bad flag, missing positional, etc.). */
export const EXIT_USER_ERROR = 2;
/** Gateway TCP connection refused / DNS failure / etc. */
export const EXIT_GATEWAY_DOWN = 64;
/** Gateway answered with a 5xx. */
export const EXIT_GATEWAY_ERROR = 65;
/** Batch operation completed but at least one item failed. */
export const EXIT_PARTIAL = 66;
/** Gateway returned 401 / 403 — token missing, expired, or under-scoped. */
export const EXIT_AUTH = 77;
/** User pressed Ctrl-C (SIGINT). Conventional 128 + signal-number. */
export const EXIT_CANCELLED = 130;

/** All exit codes the CLI uses. Single source for docs + tests. */
export const EXIT_CODES = {
  EXIT_OK,
  EXIT_FAILURE,
  EXIT_USER_ERROR,
  EXIT_GATEWAY_DOWN,
  EXIT_GATEWAY_ERROR,
  EXIT_PARTIAL,
  EXIT_AUTH,
  EXIT_CANCELLED,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * Throwable failure marker. Catch-and-exit runs at the top of `runCli`;
 * everywhere else just `throw new CliError(msg, code)` — including inside
 * a `withSpinner` callback. The spinner's `catch` arm re-throws so the
 * stack unwinds and the runner sees the original `CliError`.
 */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number = EXIT_FAILURE) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/**
 * Recognise a "gateway is unreachable" failure from a fetch() rejection.
 * Node's `fetch` throws `TypeError: fetch failed` with a `cause` of
 * `Error: connect ECONNREFUSED ...` — match either layer so future
 * undici/Node refactors don't silently break the heuristic.
 */
const CONNECTION_CODES =
  /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ECONNRESET|EPIPE/;

/**
 * A connection that dies *during* the TLS handshake — what a blocked port
 * behind a proxy or NAT, or a gateway restarting mid-dial, produces. Matched on
 * this specific phrasing rather than a bare "connect" substring, which would
 * swallow unrelated errors.
 */
const TLS_DISCONNECT = /disconnected before secure TLS connection/i;

export function isFetchConnectionError(err: unknown): boolean {
  if (err instanceof TypeError) {
    if (err.message.includes("fetch failed") || err.message.includes("connect")) return true;
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (!cause) return false;
    if (typeof cause.code === "string" && CONNECTION_CODES.test(cause.code)) return true;
    if (typeof cause.message === "string" && /connect/i.test(cause.message)) return true;
    return false;
  }
  // Not every unreachable-gateway failure arrives as a TypeError from fetch. A
  // socket reset mid-handshake surfaces as a plain Error carrying ECONNRESET,
  // and undici reports its own TLS disconnect the same way. Both were falling
  // past this guard to a raw stack trace, instead of the caller's "cannot reach
  // the gateway" branch.
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (typeof code === "string" && CONNECTION_CODES.test(code)) return true;
    if (TLS_DISCONNECT.test(err.message)) return true;
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause) {
      if (typeof cause.code === "string" && CONNECTION_CODES.test(cause.code)) return true;
      if (typeof cause.message === "string" && TLS_DISCONNECT.test(cause.message)) return true;
    }
  }
  return false;
}

/**
 * Citty raises `CLIError` (separate class, not exported by the package) for
 * argv-shape mistakes — missing required positionals, unknown subcommands,
 * invalid enum values. Detected by `name === "CLIError"` and an `EARG`-style
 * `code` field. The runner maps these to `EXIT_USER_ERROR` with a clean
 * one-liner message instead of a stack trace.
 */
export function isCittyParseError(
  err: unknown,
): err is { name: string; message: string; code?: string } {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string };
  return e.name === "CLIError" && typeof e.code === "string";
}
