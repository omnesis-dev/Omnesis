// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { CliError, EXIT_FAILURE } from "../utils.js";

/** An owned update child may still mutate the installation after raw exit. */
export class UpdateProcessCleanupUncertainError extends CliError {
  constructor(primaryFailure: unknown, cleanupFailure: unknown) {
    super(
      "Update process cleanup was not confirmed. The host update lock remains held. " +
        "No fallback, rollback, or daemon restart will run. Review the update process state before retrying.",
      EXIT_FAILURE,
    );
    this.name = "UpdateProcessCleanupUncertainError";
    this.cause = new AggregateError(
      [primaryFailure, cleanupFailure].filter((error) => error !== undefined),
      "Update process failed and cleanup was not confirmed",
    );
  }
}
