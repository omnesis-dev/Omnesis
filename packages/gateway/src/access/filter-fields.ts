// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which fields of a source type a filter can match on, read from the profile
 * a collector published for it.
 *
 * This is the one place the gateway interprets a profile's `filter` and
 * `personFilter` declarations. The publication route stores them unjudged,
 * because a collector newer than this gateway may declare something this
 * build does not know; here each declaration is judged against what this
 * build can apply, and what it cannot apply is reported with the reason
 * rather than dropped or guessed at.
 *
 * No source name is branched on: a declaration is source-owned data that
 * names one of the gateway's own filter capabilities.
 */

import { documentFieldFilterProblem, personFilterProblem } from "@omnesis/source-sdk";
import {
  FILTER_CAPABILITIES,
  type DocumentFieldFilterSpec,
  type FilterNoun,
  type PersonFilterSpec,
} from "@omnesis/types";
import { getStoredSourceDocumentProfile } from "../data/repositories/SourceDocumentProfileRepository.js";
import type { Db } from "../data/types.js";

/** One field a source marks as filterable, and whether this gateway can apply it. */
export type FilterField =
  | {
      path: string;
      state: "ready";
      /** What the field holds: one id, or a list of them. */
      type: "string" | "string-array";
      filter: DocumentFieldFilterSpec;
    }
  /** The source declares a capability this gateway does not have. */
  | { path: string; state: "gateway-behind"; capability: string }
  /** The declaration breaks the source contract; `problem` says how. */
  | { path: string; state: "invalid"; problem: string };

/** A source's person-filter declaration, and whether this gateway can apply it. */
export type PersonFilter =
  { state: "ready"; filter: PersonFilterSpec } | { state: "invalid"; problem: string };

export type SourceFilterFields =
  /** No collector has published a profile for the source type. */
  | { state: "no-profile" }
  /**
   * The stored profile came from a collector that publishes no source version,
   * so it predates filter declarations and none can be read from it.
   */
  | { state: "collector-behind" }
  | {
      state: "declared";
      /** The source version the profile was published at. */
      outputRevision: number;
      /** Every field the profile marks as filterable, in declaration order. */
      fields: FilterField[];
      /** The profile's person filter, or `null` when it declares none. */
      person: PersonFilter | null;
    };

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(FILTER_CAPABILITIES);

/**
 * The filterable fields and person filter of one source type.
 *
 * The caller passes the source type, not a source id: a profile describes the
 * source contract and is the same for every account.
 */
export function filterFieldsFor(db: Db, sourceType: string): SourceFilterFields {
  const stored = getStoredSourceDocumentProfile(db, sourceType);
  if (!stored) return { state: "no-profile" };
  if (stored.outputRevision === 0) return { state: "collector-behind" };

  // Read as plain data: the stored profile is whatever some build published.
  const profile: { personRoles?: unknown; metadataFields?: unknown; personFilter?: unknown } =
    stored.profile;
  const declared = Array.isArray(profile.metadataFields) ? profile.metadataFields : [];
  const context = { outputRevision: stored.outputRevision };

  const fields: FilterField[] = [];
  for (const field of declared) {
    if (!isRecord(field) || typeof field.path !== "string" || field.filter === undefined) continue;
    fields.push(readField(field.path, field.type, field.filter, context));
  }

  let person: PersonFilter | null = null;
  if (profile.personFilter !== undefined) {
    const problem = personFilterProblem(
      profile.personFilter,
      {
        personRoles: Array.isArray(profile.personRoles) ? profile.personRoles : [],
        metadataFields: declared,
      },
      context,
    );
    person = problem
      ? { state: "invalid", problem }
      : { state: "ready", filter: personFilterSpec(profile.personFilter as PersonFilterSpec) };
  }

  return { state: "declared", outputRevision: stored.outputRevision, fields, person };
}

function readField(
  path: string,
  type: unknown,
  filter: unknown,
  context: { outputRevision: number },
): FilterField {
  // Asked before the contract check: a capability this build has never heard
  // of is a newer collector, not a broken declaration, and the two call for
  // different remedies.
  if (
    isRecord(filter) &&
    typeof filter.capability === "string" &&
    !KNOWN_CAPABILITIES.has(filter.capability)
  ) {
    return { path, state: "gateway-behind", capability: filter.capability };
  }
  const problem = documentFieldFilterProblem(String(type), filter, context);
  if (problem) return { path, state: "invalid", problem };
  return {
    path,
    state: "ready",
    type: type as "string" | "string-array",
    filter: fieldFilterSpec(filter as DocumentFieldFilterSpec),
  };
}

/** The declaration reduced to the keys this build knows, so a key a newer collector added does not travel on. */
function fieldFilterSpec(filter: DocumentFieldFilterSpec): DocumentFieldFilterSpec {
  return {
    capability: filter.capability,
    minVersion: filter.minVersion,
    scope: filter.scope,
    noun: noun(filter.noun),
    ...(filter.levels ? { levels: filter.levels.map(noun) } : {}),
    picker: filter.picker,
    ...(filter.inside ? { inside: noun(filter.inside) } : {}),
    ...(filter.listsMembers !== undefined ? { listsMembers: filter.listsMembers } : {}),
  };
}

/** See {@link fieldFilterSpec}. */
function personFilterSpec(filter: PersonFilterSpec): PersonFilterSpec {
  return {
    minVersion: filter.minVersion,
    roles: [...filter.roles],
    identifiers: [...filter.identifiers],
    ...(filter.maxPeople !== undefined ? { maxPeople: filter.maxPeople } : {}),
    ...(filter.membersOf !== undefined ? { membersOf: filter.membersOf } : {}),
  };
}

function noun(value: FilterNoun): FilterNoun {
  return { one: value.one, many: value.many };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
