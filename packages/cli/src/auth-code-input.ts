// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Parse user-pasted input from an OAuth redirect into a decoded
 * authorization code.
 *
 * Accepted shapes:
 *   - a full redirect URL — either the provider's redirect or the
 *     gateway's `/oauth/callback?state=…&code=…` shape. The code is read
 *     from the `code` query parameter; `URL.searchParams` already
 *     percent-decodes it.
 *   - a bare code — percent-decoded iff it contains `%` (a code copied
 *     out of a URL bar may still be encoded; an already-decoded code
 *     containing no `%` passes through verbatim).
 *
 * Pure — no I/O. Throws with a user-readable message on anything else.
 */
export function parseAuthCodeInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Empty input — paste the full redirect URL or the authorization code.");
  }

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error(
        "That looks like a URL but could not be parsed — paste the full redirect URL including its query string.",
      );
    }
    const code = url.searchParams.get("code");
    if (!code) {
      throw new Error(
        "No `code` query parameter in that URL — paste the full redirect URL including its query string.",
      );
    }
    return code;
  }

  if (/\s/.test(trimmed)) {
    throw new Error("That doesn't look like an authorization code or a redirect URL.");
  }

  if (trimmed.includes("%")) {
    try {
      return decodeURIComponent(trimmed);
    } catch {
      throw new Error(
        "Code looks percent-encoded but could not be decoded — paste the raw code or the full redirect URL.",
      );
    }
  }

  return trimmed;
}
