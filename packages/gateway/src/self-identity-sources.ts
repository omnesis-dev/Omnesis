// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Registry of per-source self-identity hooks — how each source's account id
 * maps to the stable LID alias its own normalizer attaches to documents that
 * represent the user themselves (a Strava athlete profile, a GitHub login).
 *
 * The self-detection pass (`detectSelfFromSourceIds` in
 * `domain/ContactCardBootstrap.ts`) pairs every registered source account
 * against the matching hook, so the LID a source emits on its self-authored
 * PersonMentions resolves to the canonical self person — instead of branching
 * on a hardcoded source name in the gateway. No source-specific knowledge
 * lives here: the "what is this source's self LID shape" decision stays inside
 * each source package's `defineSource.selfIdentity`.
 *
 * Collector-declared and merged by source type. Each collector derives its
 * entries from the sources IT hosts and POSTs them via
 * `POST /admin/self-identity-sources` on boot and on every source add. A
 * collector hosting none of these sources pushes an empty list, and one on an
 * older pin pushes fewer than its peer — each push is complete for that
 * collector and says nothing about the others, so a push upserts by source
 * type and never clears what a sibling declared. The cost is a stale entry
 * for a source type no collector hosts any more, which pairs nothing: the
 * pass walks the sources table, not the registry.
 *
 * The registry lives on the HTTP thread, where pushes land. The pass runs on
 * the writer worker, whose copy of this module never receives a push, so
 * every caller passes `listSelfIdentitySources()` to the pass; the worker
 * never reads this module's map.
 */

/**
 * One source type's declared self-identity hook. Mirrors
 * `SelfIdentitySpec` from `@omnesis/source-sdk`, keyed by the source-type
 * prefix (the part of a source id before the first `:`).
 */
export interface SelfIdentitySource {
  /** Source-type prefix, e.g. `strava-activities`, `github`. */
  sourceType: string;
  /** Prefix prepended to the account to form the self LID alias. */
  aliasPrefix: string;
  /** Optional regex the account portion must match for the pairing to apply. */
  accountPattern?: string;
}

const collectorDeclared = new Map<string, SelfIdentitySource>();

/**
 * Fold one collector's declared hooks into the registry: an entry per source
 * type, the newest declaration for a type winning. An empty list changes
 * nothing.
 */
export function mergeSelfIdentitySources(entries: readonly SelfIdentitySource[]): void {
  for (const entry of entries) collectorDeclared.set(entry.sourceType, entry);
}

/** Every hook the install knows, ordered by source type. */
export function listSelfIdentitySources(): SelfIdentitySource[] {
  return [...collectorDeclared.values()].sort((a, b) => a.sourceType.localeCompare(b.sourceType));
}

/** Index hooks by source type — the shape `resolveSelfIdentityAlias` reads. */
export function indexSelfIdentitySources(
  hooks: readonly SelfIdentitySource[],
): ReadonlyMap<string, SelfIdentitySource> {
  return new Map(hooks.map((hook) => [hook.sourceType, hook]));
}

/**
 * Resolve a self LID alias for a synced source account, or `null` when no
 * hook matches the source type (or the account fails the declared pattern).
 * The alias is `${aliasPrefix}:${identity}` — the shape the source's
 * normalizer emits on its self-authored PersonMentions — where the identity
 * is the account itself, or the part a declared pattern captures when the
 * account id carries more than the identity.
 */
export function resolveSelfIdentityAlias(
  hooks: ReadonlyMap<string, SelfIdentitySource>,
  sourceType: string,
  account: string,
): string | null {
  const spec = hooks.get(sourceType);
  if (!spec) return null;
  if (!spec.accountPattern) return `${spec.aliasPrefix}:${account}`;
  const match = new RegExp(spec.accountPattern).exec(account);
  if (!match) return null;
  // A capture group names the identity inside the account id, for sources
  // whose account carries more than the identity — a second credential for
  // the same user, scoped elsewhere, is a distinct account (`login@scope`)
  // while its documents still carry the plain identity's LID.
  return `${spec.aliasPrefix}:${match[1] ?? account}`;
}

/** Test-only: reset the registry to empty. */
export function resetSelfIdentitySources(): void {
  collectorDeclared.clear();
}
