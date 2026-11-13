// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The sign-in pairing requests a person can still answer.
 *
 * The gateway keeps a decided request until it expires, because the device
 * that asked reads the answer from it. Here a request stops waiting as soon as
 * it is approved or denied, or once its time has run out. An approval that is
 * still being written stays listed: it returns to waiting if it fails.
 */
export function waitingCloudPairingRequests(items, now = Date.now()) {
  if (!Array.isArray(items)) return [];
  return items.filter(
    (request) =>
      (request?.status === "pending" || request?.status === "approving") &&
      request.expiresAt > now,
  );
}
