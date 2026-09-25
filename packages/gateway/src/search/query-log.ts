// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

/**
 * Privacy-preserving descriptor for a search query in logs.
 *
 * Users routinely paste sensitive terms — names, identifiers, private
 * questions — into search, so the pipeline must not emit raw query text to
 * logs by default. This returns a non-reversible descriptor (length + a short
 * content hash) that is still useful for correlating log lines and spotting
 * repeated queries, without disclosing the text.
 *
 * Set `OMNESIS_LOG_QUERIES=1` to opt into raw query text for local debugging.
 */
export function describeQuery(text: string): string {
  if (process.env.OMNESIS_LOG_QUERIES === "1") return `"${text}"`;
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 8);
  return `q[len=${text.length} h=${hash}]`;
}
