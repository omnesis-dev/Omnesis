// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Who runs a source.
 *
 * Most sources are run by the host: it decides when, on a cadence or because
 * something asked, calls the factory, and drives a page loop. A few are not run
 * by anything here at all — a phone or a browser extension posts their
 * documents to the gateway directly, and the collector's only involvement is
 * knowing they exist.
 *
 * That second kind had no way to say so. It was expressed as two booleans that
 * were always set together and named different questions — one meaning "never
 * schedule this", the other "do not advertise this" — and, because the contract
 * still demanded a factory, as a stub returning an empty page forever. Three
 * sources ship such a stub. The conformance suite already flags them as a wart:
 * a source that nothing drives should not have to satisfy the shape of one that
 * something does.
 *
 * So this is the declaration those booleans were standing in for. A source
 * says how it is run, once, and the host reads it.
 */
export type ExecutionMode =
  /**
   * The host drives it — a cadence tick, an operator's request, a watched file
   * changing, or a source's own wake callback asking to be run now.
   *
   * The default, because it is what a source is unless it says otherwise.
   */
  | "pull"
  /**
   * Nothing here drives it. Its documents arrive at the gateway from somewhere
   * outside this host, and the declaration exists so the rest of the system —
   * the registry, the status view, the analytics catalog, the watch
   * vocabulary — knows the source exists.
   *
   * Such a source declares no factory. There is nothing for one to return.
   */
  | "external";

/** How a source is run, defaulting to the one that needs no declaration. */
export function executionModeOf(
  declared: { execution?: ExecutionMode; pushBased?: boolean } | undefined,
): ExecutionMode {
  if (declared?.execution) return declared.execution;
  // The boolean this replaces, read for a source that has not migrated. It
  // asked the same question and only the two answers below were ever given.
  return declared?.pushBased ? "external" : "pull";
}

/** Whether the host runs this source at all. */
export function isDrivenByHost(declared: {
  execution?: ExecutionMode;
  pushBased?: boolean;
}): boolean {
  return executionModeOf(declared) === "pull";
}
