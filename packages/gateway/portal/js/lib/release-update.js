// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const INSTALL_METHODS = new Set(["source", "npm-global", "docker"]);

function compareStableVersions(left, right) {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  for (let i = 0; i < 3; i += 1) {
    const a = leftParts[i];
    const b = rightParts[i];
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Convert the untrusted `/status` field into the only state the sidebar needs.
 * Any malformed or internally inconsistent snapshot stays invisible.
 */
export function releaseUpdateFromStatus(status) {
  const release = status?.release;
  if (
    !release ||
    typeof release !== "object" ||
    typeof release.currentVersion !== "string" ||
    !STABLE_VERSION.test(release.currentVersion) ||
    typeof release.latestVersion !== "string" ||
    !STABLE_VERSION.test(release.latestVersion) ||
    !INSTALL_METHODS.has(release.installMethod) ||
    typeof release.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(release.checkedAt)) ||
    release.updateAvailable !== true ||
    compareStableVersions(release.currentVersion, release.latestVersion) >= 0
  ) {
    return null;
  }
  return {
    currentVersion: release.currentVersion,
    latestVersion: release.latestVersion,
  };
}
