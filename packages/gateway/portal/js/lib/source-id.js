// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The two halves of a source id.
 *
 * A source is named at one of two specificities: a bare type — `gmail` —
 * covers every account of that type, and a qualified id —
 * `gmail:someone@example.com` — is exactly one. The split is at the FIRST
 * colon, because everything after it is one account id, colons included.
 *
 * The portal is served as static files and imports nothing from the
 * workspace, so this is a second statement of what `sourceTypeOf` /
 * `sourceAccountOf` in `@omnesis/types` say. It had been stated eight more
 * times across four portal modules, inline, which is why it is here: the
 * duplication that cannot be removed should at least be one copy.
 *
 * Both are total. An id with no usable type half — one starting with a colon
 * — answers with itself rather than the empty string, so a malformed id keys
 * only itself instead of colliding with every other malformed one.
 */
export function sourceTypeOf(sourceId) {
  if (typeof sourceId !== "string") return "";
  const colon = sourceId.indexOf(":");
  return colon <= 0 ? sourceId : sourceId.slice(0, colon);
}

/** The account half, or `""` when the id names no account. */
export function sourceAccountOf(sourceId) {
  if (typeof sourceId !== "string") return "";
  const colon = sourceId.indexOf(":");
  return colon <= 0 ? "" : sourceId.slice(colon + 1);
}
