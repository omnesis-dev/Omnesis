// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** A private issuer directory remains owned until its process cleanup is confirmed. */
export class TlsIssuerCleanupUnconfirmedError extends Error {
  readonly scratchDirectory?: string;
  constructor(
    readonly cleanupFailure: unknown,
    cause: unknown,
    scratchDirectory?: string,
  ) {
    super("TLS issuer cleanup was not confirmed; review the owned process state before retrying.", {
      cause,
    });
    this.name = "TlsIssuerCleanupUnconfirmedError";
    this.scratchDirectory = scratchDirectory;
  }
}

/** Preserve only the canonical explicit marker, including when a command also failed. */
export function tlsIssuerCleanupFailure(
  error: unknown,
  scratchDirectory?: string,
): TlsIssuerCleanupUnconfirmedError | null {
  if (error instanceof TlsIssuerCleanupUnconfirmedError) {
    return scratchDirectory === undefined || error.scratchDirectory === scratchDirectory
      ? error
      : new TlsIssuerCleanupUnconfirmedError(error.cleanupFailure, error, scratchDirectory);
  }
  if (
    error !== null &&
    typeof error === "object" &&
    "cleanupFailure" in error &&
    error.cleanupFailure !== undefined
  )
    return new TlsIssuerCleanupUnconfirmedError(error.cleanupFailure, error, scratchDirectory);
  return null;
}
