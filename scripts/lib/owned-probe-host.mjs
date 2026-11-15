// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

function marked(error) {
  return (
    error !== null &&
    (typeof error === "object" || typeof error === "function") &&
    Object.hasOwn(error, "cleanupFailure")
  );
}
function failure(errors, unconfirmed, proofFailure) {
  const receipt = errors.find(marked);
  const error = new AggregateError(
    errors,
    unconfirmed
      ? "Owned probe host cleanup was not confirmed"
      : "Owned probe host signal failed after confirmed cleanup",
    { cause: receipt !== undefined ? receipt : unconfirmed ? proofFailure : errors[0] },
  );
  if (unconfirmed || receipt !== undefined)
    Object.assign(error, {
      cleanupFailure: receipt !== undefined ? receipt.cleanupFailure : proofFailure,
    });
  return error;
}

/** Scratch retirement requires the caller's raw-close and kernel-join proof. */
export async function stopOwnedProbeHost(child, joined, graceMs = 5000) {
  let timer;
  const errors = [];
  const closing = Promise.resolve(joined);
  const outcome = closing.then(
    () => ({ joined: true }),
    (reason) => ({ joined: false, reason }),
  );
  const stop = (signal) => {
    try {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null)
        child.kill(signal);
    } catch (error) {
      errors.push(error);
    }
  };
  try {
    stop("SIGINT");
    const first = await Promise.race([
      outcome,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), graceMs);
      }),
    ]);
    if (first === null) stop("SIGKILL");
    // A signaling failure cannot substitute for joining independent close proof.
    const proof = await outcome;
    if (!proof.joined) {
      errors.push(proof.reason);
      throw failure(errors, true, proof.reason);
    }
    if (errors.length) throw failure(errors, false);
  } finally {
    clearTimeout(timer);
  }
}
