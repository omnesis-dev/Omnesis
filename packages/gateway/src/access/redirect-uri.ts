// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Match registered redirects exactly, except for a native loopback listener's
 * operating-system-assigned port. Web redirects never receive this exception.
 */
export function registeredRedirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  let left: URL;
  let right: URL;
  try {
    left = new URL(registered);
    right = new URL(requested);
  } catch {
    return false;
  }
  if (
    left.protocol !== "http:" ||
    right.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(left.hostname) ||
    left.hostname !== right.hostname
  ) {
    return false;
  }
  return (
    left.pathname === right.pathname &&
    left.search === right.search &&
    left.hash === right.hash &&
    left.username === right.username &&
    left.password === right.password
  );
}
