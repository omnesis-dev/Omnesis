// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { validateStateSpec, type SourceState, type SourceStateSpec } from "./source-state.js";

/**
 * What a source declares about its own evolution, and what it needs from the
 * host that runs it.
 *
 * Three numbers that are routinely confused, kept apart here because they move
 * for different reasons and have different consequences:
 *
 * - `apiVersion` — which generation of *this SDK* the package is written
 *   against. Moves when the authoring contract changes. A host refuses a
 *   package it is too old to run.
 * - `state.version` — the shape of the bookmark the source persists. Moves
 *   when that shape changes. Governs migrations. See `source-state.ts`.
 * - `outputRevision` — the meaning of what the source *emits*. Moves when a
 *   normalizer starts producing different documents or rows from the same
 *   upstream input. Governs reprocessing.
 *
 * The third is the one that has no equivalent anywhere in the tree today, and
 * it is the one that silently rots a corpus: a normalizer change leaves every
 * previously ingested document as it was, so the store ends up holding two
 * generations of meaning under one schema, with nothing recording which is
 * which. Declaring it does not by itself reprocess anything — it records the
 * fact so that a backfill *can* be targeted later, and so that a document's
 * provenance can say which revision produced it.
 */

/**
 * The SDK's current authoring-contract generation.
 *
 * Bump when a change to the authoring surface means packages written against
 * the previous generation can no longer be loaded unchanged. Additive changes
 * — a new optional field, a new capability a source may declare — do not move
 * it; that is what {@link HostCapability} is for.
 */
export const SOURCE_API_VERSION = 2 as const;

/**
 * The oldest authoring-contract generation this host can still load.
 *
 * Generation 1 is every package written before this mechanism existed: they
 * declare no `apiVersion` at all and are treated as 1. Raising this floor is
 * the supported way to retire a generation, and it is the one place that
 * decides whether an old package is refused rather than merely warned about.
 */
export const MINIMUM_SOURCE_API_VERSION = 1 as const;

/**
 * Behaviour a source may require of the host that runs it.
 *
 * A capability is declared by a source that *cannot work correctly* without
 * it, so that an older host refuses the package outright instead of running it
 * with the behaviour silently missing. That distinction matters most for the
 * capabilities that concern deletion: a host that ignores a scoped snapshot
 * session does not merely lose a feature, it loses the source's only means of
 * detecting deletions, and nothing downstream can tell.
 *
 * Capabilities are additive and never removed — retiring one is what
 * {@link SOURCE_API_VERSION} is for.
 */
export type HostCapability =
  /** The host wraps persisted state in a versioned envelope and runs migrations. */
  | "state-envelope"
  /** The host accepts a page naming rows for several tables at once. */
  | "multi-table-batch"
  /** The host supports snapshot sessions scoped to a declared partition. */
  | "snapshot-sessions"
  /** The host can delete an analytics row by a full primary-key tuple. */
  | "tuple-deletes"
  /** The host injects a scoped `SourceHost` rather than its own gateway client. */
  | "scoped-host"
  /** The host derives setup forms from a declared config schema. */
  | "typed-config"
  /** The host assigns opaque connection identities and resolves legacy aliases. */
  | "connection-identity";

/** Every capability this build of the host provides. */
export const HOST_CAPABILITIES: readonly HostCapability[] = [
  "state-envelope",
  "multi-table-batch",
  "snapshot-sessions",
  "tuple-deletes",
  "scoped-host",
  "typed-config",
] as const;

/**
 * The evolution declaration carried by a source definition or a provider's
 * source entry. Every field is optional: a package that declares none of it is
 * generation 1 with unversioned state, which is exactly what every package in
 * the tree was before this existed.
 */
export interface SourceContractDeclaration<S extends SourceState = SourceState> {
  /**
   * Which generation of the authoring contract this package is written
   * against. Omitted means 1.
   */
  apiVersion?: number;

  /**
   * The shape of the state this source persists between runs, and how to read
   * every older shape. See {@link SourceStateSpec}.
   *
   * Omitted means the source keeps the pre-envelope behaviour: its stored
   * value is handed back raw, and anything unrecognisable is indistinguishable
   * from a first run.
   */
  state?: SourceStateSpec<S>;

  /**
   * The revision of this source's *output meaning*. Bump when the normalizer
   * changes what it produces from unchanged upstream input: a new field on
   * every document, a corrected timestamp interpretation, a different
   * externalId derivation.
   *
   * Bumping is a claim that previously stored output is a different generation
   * from what this build would write now. It does not trigger anything on its
   * own; it makes a targeted backfill possible, and keeps the fact from being
   * lost. Omitted means 1.
   */
  outputRevision?: number;

  /**
   * Host behaviour this source cannot work correctly without. A host missing
   * any of these refuses to load the package rather than running it degraded.
   */
  requires?: readonly HostCapability[];
}

/**
 * Combine a provider's declaration with one of its source entries'.
 *
 * Field-wise, not wholesale. A provider declares what belongs to the package —
 * the authoring generation it targets, the host capabilities every source
 * under it needs — and an entry declares what belongs to itself: the shape of
 * its own bookmark and the revision of its own output. Replacing one object
 * with the other silently drops whichever half the entry did not restate,
 * which is how a package ends up claiming generation 1 while declaring a
 * generation 2 feature.
 *
 * Required capabilities are the union: an entry needs everything the package
 * needs, plus anything it needs on its own.
 */
export function mergeContractDeclarations(
  provider: SourceContractDeclaration | undefined,
  entry: SourceContractDeclaration | undefined,
): SourceContractDeclaration | undefined {
  if (!provider) return entry;
  const requires = [...new Set([...(provider.requires ?? []), ...(entry?.requires ?? [])])];
  return {
    apiVersion: entry?.apiVersion ?? provider.apiVersion,
    outputRevision: entry?.outputRevision ?? provider.outputRevision,
    // State is never inherited. Two sources sharing one account persist
    // unrelated bookmarks, so a provider-level state spec would migrate one
    // source's state with another's rules.
    state: entry?.state,
    requires: requires.length > 0 ? requires : undefined,
  };
}

/** Why a host refused to load a source package. */
export interface ContractIncompatibility {
  kind: "api-too-new" | "api-too-old" | "missing-capability";
  message: string;
  /** For `missing-capability`: which ones. */
  capabilities?: HostCapability[];
}

/**
 * Decide whether this host can run a package, before instantiating anything.
 *
 * Returns `null` when the package is loadable. The check is deliberately
 * pure and takes the host's own generation and capabilities as arguments, so a
 * test can ask "what would a host from two releases ago do with this?" without
 * having a host from two releases ago.
 */
export function checkContractCompatibility(
  declaration: SourceContractDeclaration | undefined,
  where: string,
  host?: {
    apiVersion?: number;
    minimumApiVersion?: number;
    capabilities?: readonly HostCapability[];
  },
): ContractIncompatibility | null {
  const hostApi = host?.apiVersion ?? SOURCE_API_VERSION;
  const hostMinimum = host?.minimumApiVersion ?? MINIMUM_SOURCE_API_VERSION;
  const hostCapabilities = host?.capabilities ?? HOST_CAPABILITIES;

  const declared = declaration?.apiVersion ?? 1;

  if (declared > hostApi) {
    return {
      kind: "api-too-new",
      message:
        `${where} is written against source API version ${declared}, but this build speaks ${hostApi}. ` +
        `Upgrade the host, or install a build of this source written for API ${hostApi}.`,
    };
  }
  if (declared < hostMinimum) {
    return {
      kind: "api-too-old",
      message:
        `${where} is written against source API version ${declared}, which this build no longer supports ` +
        `(the oldest supported is ${hostMinimum}). Update the source package.`,
    };
  }

  const missing = (declaration?.requires ?? []).filter((c) => !hostCapabilities.includes(c));
  if (missing.length > 0) {
    return {
      kind: "missing-capability",
      capabilities: missing,
      message:
        `${where} requires host capabilities this build does not provide: ${missing.join(", ")}. ` +
        `Running it anyway would silently drop the behaviour it depends on.`,
    };
  }
  return null;
}

/**
 * Validate an evolution declaration at definition time, so a malformed one
 * fails at package load rather than on the first run that depends on it.
 */
export function validateContractDeclaration(
  declaration: SourceContractDeclaration | undefined,
  where: string,
): void {
  if (!declaration) return;
  const { apiVersion, outputRevision, state, requires } = declaration;

  if (apiVersion !== undefined && (!Number.isInteger(apiVersion) || apiVersion < 1)) {
    throw new Error(`${where}: apiVersion must be an integer >= 1, got ${String(apiVersion)}`);
  }
  if (apiVersion !== undefined && apiVersion > SOURCE_API_VERSION) {
    throw new Error(
      `${where}: apiVersion ${apiVersion} is ahead of this SDK (${SOURCE_API_VERSION}). ` +
        `A package cannot declare a generation the SDK it is compiled against does not define.`,
    );
  }
  if (outputRevision !== undefined && (!Number.isInteger(outputRevision) || outputRevision < 1)) {
    throw new Error(
      `${where}: outputRevision must be an integer >= 1, got ${String(outputRevision)}`,
    );
  }
  if (requires) {
    const unknown = requires.filter((c) => !KNOWN_CAPABILITIES.has(c));
    if (unknown.length > 0) {
      throw new Error(
        `${where}: requires names capabilities this SDK does not define: ${unknown.join(", ")}`,
      );
    }
  }
  if (state) {
    validateStateSpec(state, where);
    // A source that declares versioned state is relying on the host to run its
    // migrations. Saying so explicitly is what stops an older host from
    // handing it a raw legacy value and letting its decoder reject it, which
    // would read as corruption rather than as a host that is too old.
    const dependsOnHost =
      state.version > 1 ||
      typeof state.legacyVersion === "function" ||
      state.onUnreadable === "stop" ||
      state.maxBytes !== undefined;
    if (dependsOnHost && !(requires ?? []).includes("state-envelope")) {
      const why =
        state.version > 1
          ? `state.version is ${state.version} with migrations`
          : typeof state.legacyVersion === "function"
            ? "state.legacyVersion classifies values written before envelopes existed"
            : state.onUnreadable === "stop"
              ? "state.onUnreadable protects unreadable bookmarks from being discarded"
              : "state.maxBytes requires the host to enforce a persisted-state ceiling";
      throw new Error(
        `${where}: ${why}, so the source depends on the host applying its state declaration. ` +
          `Declare requires: ["state-envelope"] so an older host refuses the package instead of ` +
          `silently handing it a value it will misread.`,
      );
    }
  }
}

const KNOWN_CAPABILITIES = new Set<string>([
  "state-envelope",
  "multi-table-batch",
  "snapshot-sessions",
  "tuple-deletes",
  "scoped-host",
  "typed-config",
  "connection-identity",
]);
