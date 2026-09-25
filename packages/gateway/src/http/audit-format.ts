// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Short, log-safe prefix of a token id for the access log. Never returns the
 * full id (so a leaked log line can't be replayed); falls back to "anon" for
 * unauthenticated requests.
 */
export function tokenIdLogPrefix(id: string | null | undefined): string {
  return id ? id.slice(0, 6) : "anon";
}
