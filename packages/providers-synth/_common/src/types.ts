// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared types for the synthetic-provider framework.
 *
 * The cast is a single source-of-truth manifest describing the "world"
 * that every synth source's fixtures reference symbolically. Cross-source
 * coverage (people-resolution, link extraction, search across sources)
 * works because every source resolves the same persona ref the same way.
 */

import type { PersonMention, PersonRole } from "@omnesis/types";

export interface PersonAliases {
  /** Generic email aliases — gmail, outlook, etc. share this pool. */
  emails?: string[];
  /** Phone aliases — whatsapp, imessage. */
  phones?: string[];
  /** WhatsApp LIDs (linked-identity IDs). */
  lids?: string[];
  /** Source-internal IDs that don't fit the above (e.g. notion user id). */
  extra?: Record<string, string>;
}

export interface Person extends PersonAliases {
  /** Stable cast-internal id, e.g. "p_john". */
  id: string;
  /** Display name. */
  name: string;
}

export interface Org {
  id: string;
  name: string;
  domain?: string;
}

export interface Cast {
  /** Id of the persona that represents the gateway's operator. */
  self: string;
  people: Person[];
  orgs: Org[];
}

/** Symbolic person reference used in fixtures. `"self"` resolves via Cast.self. */
export type PersonRef = string;

export interface ResolvedPerson {
  name: string;
  emails: string[];
  phones: string[];
  lids: string[];
  isSelf: boolean;
}

export interface ResolvedPersonMention extends ResolvedPerson {
  role: PersonRole;
}

/** Shape every synth source's cursor has. */
export interface SynthCursor {
  /** Index of the next fixture entry to emit. */
  offset?: number;
  [key: string]: unknown;
}
