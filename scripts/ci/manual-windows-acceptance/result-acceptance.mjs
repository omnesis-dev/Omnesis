// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Joined cleanup does not erase an operation timeout or cancellation. */
export function acceptedManualMode(claim, result) {
  return (
    claim === true &&
    result.exitCode === 0 &&
    result.failure === undefined &&
    !Object.hasOwn(result, "cleanupFailure")
  );
}
