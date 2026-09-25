// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** HTTPS access is optional at install time and requested when the user pairs. */
export const CAPTURE_ORIGINS = ["https://*/*"];

export function needsCapturePermissionRepair(paired: boolean, granted: boolean): boolean {
  return paired && !granted;
}

type RequestPermission = (permissions: chrome.permissions.Permissions) => Promise<boolean>;
type GetPermissions = () => Promise<chrome.permissions.Permissions>;
type RemovePermission = (permissions: chrome.permissions.Permissions) => Promise<boolean>;

export function hasCapturePermission(
  getAll: GetPermissions = () => chrome.permissions.getAll(),
): Promise<boolean> {
  return getAll().then((permissions) =>
    CAPTURE_ORIGINS.every((origin) => permissions.origins?.includes(origin) === true),
  );
}

/** Require Chrome's explicit host grant before pairing can claim capture is ready. */
export async function requestCapturePermission(
  request: RequestPermission = (permissions) => chrome.permissions.request(permissions),
): Promise<void> {
  const granted = await request({ origins: CAPTURE_ORIGINS });
  if (!granted) {
    throw new Error(
      "HTTPS page access was not granted. Omnesis needs this permission to capture pages you read.",
    );
  }
}

/** Relinquish page access after capture is explicitly unpaired. */
export function revokeCapturePermission(
  remove: RemovePermission = (permissions) => chrome.permissions.remove(permissions),
): Promise<boolean> {
  return remove({ origins: CAPTURE_ORIGINS });
}
