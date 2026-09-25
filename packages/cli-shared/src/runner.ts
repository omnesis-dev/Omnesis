// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  CliError,
  EXIT_CANCELLED,
  EXIT_FAILURE,
  EXIT_GATEWAY_DOWN,
  EXIT_OK,
  EXIT_USER_ERROR,
  isCittyParseError,
  isFetchConnectionError,
} from "./errors.js";

export interface RunCliOptions {
  /**
   * Override stderr writer — tests pass `(s) => buffer.push(s)` to assert
   * what would have been printed without polluting the real stderr.
   */
  stderr?: (s: string) => void;
  /**
   * SIGINT handler override. Defaults to a one-shot `process.exit(130)`
   * registered at the start and removed at the end. Tests can supply a
   * spy to assert "we'd have exited 130" without actually killing the
   * test process.
   */
  onSigint?: () => void;
  /**
   * Hint shown when a fetch-connection error is detected. Lets the caller
   * inject the live `OMNESIS_GATEWAY_URL` into the message.
   */
  gatewayDownHint?: string;
}

/**
 * Run a CLI command body. Returns the exit code so the caller can do
 * `process.exit(code)` once — keeping `runCli` itself terminator-free
 * means tests can verify behaviour without forcibly exiting Node.
 *
 * Mapping:
 *   - clean return                     → `EXIT_OK`
 *   - `throw new CliError(msg, code)`  → `code`, message printed to stderr
 *   - fetch connect-refused / DNS      → `EXIT_GATEWAY_DOWN` (with hint)
 *   - any other Error                  → `EXIT_FAILURE`, stack printed
 *
 * SIGINT is wired through `opts.onSigint`. By default the listener calls
 * `process.exit(130)` directly — there's no way to gracefully unwind a
 * truly-async hot loop without an `AbortSignal`, and SIGINT semantics
 * (Ctrl-C) match "terminate now" anyway. Tests pass a mock to assert
 * registration without actually exiting.
 */
export async function runCli(
  fn: () => Promise<void> | void,
  opts: RunCliOptions = {},
): Promise<number> {
  const stderr = opts.stderr ?? ((s) => process.stderr.write(s));
  const onSigint = opts.onSigint ?? (() => process.exit(EXIT_CANCELLED));
  process.once("SIGINT", onSigint);

  try {
    await fn();
    return EXIT_OK;
  } catch (err) {
    if (err instanceof CliError) {
      if (err.message) stderr(err.message + "\n");
      return err.exitCode;
    }
    if (isCittyParseError(err)) {
      // Citty's argv-shape errors (missing positional, unknown subcommand,
      // bad enum value). Map to EXIT_USER_ERROR so scripts can branch on it.
      stderr(err.message + "\n");
      return EXIT_USER_ERROR;
    }
    if (isFetchConnectionError(err)) {
      const hint = opts.gatewayDownHint ?? "Cannot reach gateway. Is it running?";
      stderr(hint + "\n");
      return EXIT_GATEWAY_DOWN;
    }
    if (err instanceof Error) {
      stderr((err.stack ?? err.message) + "\n");
    } else {
      stderr(String(err) + "\n");
    }
    return EXIT_FAILURE;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
