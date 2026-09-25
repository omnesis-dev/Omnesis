// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./chrome-api.js";

/**
 * Chrome host-access state, mirrored into storage by the worker so the content
 * script can fail closed without a `chrome.permissions` call. Token-free like
 * `pairing-record.ts`, and for the same reason: it is imported from the page
 * context.
 */
export const CAPTURE_PERMISSION_STATE_KEY = "omnesis.capture.hostPermission.v1";

export async function loadCapturePermissionState(
  storage: Pick<chrome.storage.StorageArea, "get"> = chrome.storage.local,
): Promise<boolean> {
  const stored = await storage.get(CAPTURE_PERMISSION_STATE_KEY);
  return stored[CAPTURE_PERMISSION_STATE_KEY] === true;
}
