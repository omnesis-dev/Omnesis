// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Source-pattern resolution.
 *
 * Translates user-facing source patterns (CLI args, `source:` filter
 * tokens) into the concrete `<type>:<account>` source IDs they cover.
 * Both the CLI's `sync`/`add` commands and the gateway's `source:`
 * search filter route through here so the language stays consistent:
 *
 *   exact source ID         `gmail:alice@example.com` → that one source
 *   exact provider ID       `google:alice@example.com` → every source under that provider
 *   bare source type        `gmail`                    → every `gmail:<account>`
 *   bare provider type      `google`                   → every source whose providerId starts with `google:`
 *   trailing-colon prefix   `gmail:` / `google:`       → same as bare (kept for CLI back-compat)
 *   trailing `*` wildcard   `gmail*` / `gmail:*`       → trailing wildcard is stripped, then matched as above
 *   special                 `all`                      → every entry
 *
 * The matcher unions across all rules per pattern; multiple patterns
 * union across each other. Order is preserved for the input; output
 * is set-deduped but otherwise insertion-ordered.
 */

export interface SourceEntry {
  /** Full source ID (e.g. `gmail:maya.reeves@example.com`, `things`). */
  id: string;
  /** Full provider ID (e.g. `google:alice@example.com`, `system`). */
  providerId: string;
}

/**
 * Resolve one or more user-facing patterns against the configured
 * source set. See module header for the full grammar.
 */
export function resolveSourcePatterns(
  patterns: readonly string[],
  entries: readonly SourceEntry[],
): string[] {
  const matched = new Set<string>();
  for (const raw of patterns) {
    // Deliberately not `sourceIdAddresses`. That rule knows two
    // specificities — a bare type widens, a qualified id is exact — and this
    // language has a third: a trailing colon means "children of this, under a
    // colon", which is why `apple:*` matches nothing while `apple` matches the
    // provider itself. Reducing one to the other silently widens every saved
    // pattern of that form. The boundary tests beside this file pin it.
    //
    // Normalize trailing wildcards: `gmail*` and `gmail:*` both
    // collapse onto the bare/trailing-colon form the rest of the
    // matcher already understands.
    const normalized = raw.endsWith(":*") ? raw.slice(0, -1) : raw.replace(/\*$/, "");
    if (normalized === "all") {
      for (const e of entries) matched.add(e.id);
      continue;
    }
    // Only a type widens. A bare type (`gmail`, `google`) gains the trailing
    // colon, and a pattern already ending in one (`gmail:`) is that prefix.
    // A qualified id (`gmail:alice@x.com`, `google:alice@x.com`) names one
    // source or one provider exactly: read as a prefix, `obsidian-notes:vault`
    // also named `obsidian-notes:vault2`, so a removal could take a source
    // nobody named.
    // Exact-id / exact-providerId checks cover the bare-source-ID case
    // (`things`) too.
    const prefix = !normalized.includes(":")
      ? `${normalized}:`
      : normalized.endsWith(":")
        ? normalized
        : null;
    for (const e of entries) {
      if (
        e.id === normalized ||
        e.providerId === normalized ||
        (prefix !== null && (e.id.startsWith(prefix) || e.providerId.startsWith(prefix)))
      ) {
        matched.add(e.id);
      }
    }
  }
  return [...matched];
}
