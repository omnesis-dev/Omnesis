// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * NDJSON emitters used by `auth-subprocess.ts`. Extracted to a separate
 * module so the drain semantics of `emitFinal` can be unit-tested without
 * importing the subprocess script (which runs `await` and `process.exit`
 * at module-load time).
 */

import type { AuthSubprocessEvent } from "./auth-subprocess-protocol.js";

/**
 * Fire-and-forget NDJSON emit for intermediate events (`url`, `qr`).
 * The trailing newline is required by the parser in
 * `source-ws-handlers.ts` (splits stdout on `\n`).
 */
export function emit(stream: NodeJS.WritableStream, event: AuthSubprocessEvent): void {
  stream.write(JSON.stringify(event) + "\n");
}

/**
 * Terminal NDJSON emit. Resolves only after the kernel pipe has accepted
 * the bytes. Callers `await emitFinal(...)` immediately before
 * `process.exit(...)` so the parent's stdout reader sees the event
 * before EOF.
 *
 * Node's `process.exit()` does not wait for `process.stdout` writes to
 * drain — it tears down the process immediately. Without the write
 * callback, a fast-exiting subprocess can lose its terminal line in the
 * pipe, and the parent in `source-ws-handlers.ts` reports a misleading
 * "auth subprocess exited without a complete event" error even though
 * the underlying auth flow succeeded.
 *
 * The fix has to live here rather than letting the event loop drain
 * naturally because Baileys keeps the loop alive indefinitely with WS
 * listeners and timers even after `provider.disconnect()`. The original
 * `process.exit()` was introduced in `bf58d676` ("Force exit auth
 * subprocess after completion") for exactly that reason; Bun's
 * synchronous stdout pipe writes hid the resulting race until the
 * Bun→Node migration (`622a5a31`) exposed it.
 */
export function emitFinal(
  stream: NodeJS.WritableStream,
  event: AuthSubprocessEvent,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.write(JSON.stringify(event) + "\n", (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * The stderr line to write when the install root key could not be loaded, or
 * `null` when there is nothing to say.
 *
 * Priming the key cache answers `false` rather than throwing when the key is
 * out of reach — a locked keyring, or a backend named by `OMNESIS_SECRET_STORE`
 * whose passphrase has no source in this process's environment. The flow then
 * fails much later, reading an encrypted credential file, with an error that
 * names the file and not the keyring. This puts the cause on the record while
 * it is still visible.
 *
 * Silent unless encryption is actually in use: an install with no keyring
 * primes nothing and is working exactly as intended, and warning there would
 * put a scary line in front of every auth flow on a default install.
 */
export function keyringUnavailableNotice(opts: {
  primed: boolean;
  encryptionRequired: boolean;
  backend: string | undefined;
}): string | null {
  if (opts.primed || !opts.encryptionRequired) return null;
  return (
    `[auth-subprocess] install root key unavailable (secret store: ${opts.backend ?? "auto"}) — ` +
    "encrypted credentials cannot be read; the keyring is locked or its passphrase " +
    "is not reachable from this process\n"
  );
}
