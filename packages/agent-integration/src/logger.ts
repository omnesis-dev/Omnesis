// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Harness-neutral logger surface. OpenClaw supplies its structured logger at
 * runtime; direct embedders may provide the same narrow contract.
 */
export interface IntegrationLogger {
  warn(message: string): void;
  /** Routine notices; a logger without it has them written as warnings. */
  info?(message: string): void;
}

export const silentIntegrationLogger: IntegrationLogger = {
  warn() {},
};
