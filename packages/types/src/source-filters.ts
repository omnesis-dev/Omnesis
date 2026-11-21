// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a source declares about filtering its records, and the shapes a saved
 * filter and a published list take.
 *
 * A source describes its records once, in the document-event profile its
 * package declares. A field of that profile marked with a
 * {@link DocumentFieldFilterSpec} is one a filter can match on, and the
 * profile's {@link PersonFilterSpec} says how a filter matches the people a
 * record involves. The declaration names one of the gateway's filter
 * capabilities; a source chooses among them and brings no matching logic of
 * its own.
 */

import type { PersonRole } from "./document.js";

/**
 * The ways of matching the gateway knows.
 *
 * - `membership` — a record belongs to one or more named things.
 * - `tree` — a record sits somewhere in a tree, and matching a node covers
 *   everything beneath it.
 * - `person` — a record involves a person.
 */
export const FILTER_CAPABILITIES = ["membership", "tree", "person"] as const;
export type FilterCapability = (typeof FILTER_CAPABILITIES)[number];

/** A noun in both numbers, as a picker shows it: `label` / `labels`. */
export interface FilterNoun {
  one: string;
  many: string;
}

/**
 * Marks a metadata field as one a filter can match on.
 *
 * The field holds the source's own id for what a record belongs to, never a
 * display name. On a `string-array` field an empty array means the record
 * belongs to nothing and an absent field means it is not known; a `string`
 * field has no way to say "nothing", so it suits only a field whose records
 * each belong to exactly one thing, and it is left out of a record for which
 * that thing is not known.
 */
export interface DocumentFieldFilterSpec {
  capability: "membership" | "tree";
  /**
   * The first source version (the source's `outputRevision`) whose records
   * carry the field. `0` means records stored before versions were recorded
   * already carry it.
   */
  minVersion: number;
  /**
   * `global` when an id means the same thing on every device. `device` when it
   * only means something on the device that produced the record, so a value is
   * identified by the device together with the id; only a source whose
   * multi-device mode is `partitioned` may declare it.
   */
  scope: "global" | "device";
  /** What one value of the field is called. */
  noun: FilterNoun;
  /**
   * Tree only: a noun for each depth, roots first. The last entry names every
   * deeper level.
   */
  levels?: FilterNoun[];
  /** How a picker offers the values: a searchable list, or a tree to open. */
  picker: "search" | "tree";
  /** Tree only: what a selected node also covers, as in "Includes the folders inside." */
  inside?: FilterNoun;
  /** Whether each entry of the field's published list carries the identifiers of its members. */
  listsMembers?: boolean;
}

/** The kinds of identifier a person filter can match a record's people by. */
export const FILTER_IDENTIFIER_TYPES = ["phone", "email", "domain"] as const;
export type FilterIdentifierType = (typeof FILTER_IDENTIFIER_TYPES)[number];

/** Declares, once per profile, how a filter matches the people a record involves. */
export interface PersonFilterSpec {
  /** See {@link DocumentFieldFilterSpec.minVersion}. */
  minVersion: number;
  /** The person roles a filter considers. A mention in the text is not involvement. */
  roles: Exclude<PersonRole, "mentioned">[];
  /** The identifier kinds this source writes on the people of a record. */
  identifiers: FilterIdentifierType[];
  /**
   * The length at which the source stops listing a record's people. A record
   * holding that many may be missing some, so whether it involves a person
   * outside the list is not known.
   */
  maxPeople?: number;
  /**
   * Path of a filterable field whose published list carries members. Those
   * members count as involved in a record, together with the record's own people.
   */
  membersOf?: string;
}

/** One identifier of a person, as a filter and a published list spell it. */
export interface FilterIdentifier {
  type: FilterIdentifierType;
  value: string;
}

/** What one entry of a saved filter matches. */
export type FilterRef =
  | {
      capability: "membership" | "tree";
      /** Path of the filterable field, as the profile declares it. */
      field: string;
      /** The source's id for the thing matched. */
      id: string;
      /** The device the id belongs to, for a field whose scope is `device`. */
      device?: string;
    }
  | {
      capability: "person";
      /** The name shown for the person; matching uses the identifiers only. */
      label: string;
      identifiers: FilterIdentifier[];
    };

/** The filter one access level applies to one source. */
export interface SourceFilter {
  sourceId: string;
  audience: { accessLevel: string; capability: "direct" | "answer" };
  rules: [{ match: FilterRef[]; action: "share" | "hide" }];
  /** What happens to a record no rule matches. */
  otherwise: "share" | "hide";
}

/** One thing that exists in an account for a filterable field. */
export interface FilterListItem {
  /** The id records carry in the field. */
  id: string;
  /** The name shown in a picker. */
  label: string;
  /** The id of the node above, for a tree. Absent on a root. */
  parentId?: string;
  /** Who belongs to the item, when the field declares `listsMembers`. */
  members?: FilterIdentifier[];
  /**
   * True when the item has members that `members` does not name: one whose
   * identifier the source cannot read, or a roster the source does not hold
   * whole. Whether a person outside `members` belongs to the item is then not
   * known, and a record of the item cannot be matched against a person.
   */
  membersIncomplete?: boolean;
}

/**
 * Bounds on a published list, shared by the side that splits a list into
 * pages and the side that checks what arrives.
 */
export const FILTER_LIST_LIMITS = {
  /** List pages one sync page may carry. */
  publicationsPerPage: 8,
  /** Items in one page of a list. */
  itemsPerPart: 2000,
  /** Serialized size of one page of a list, and of the list pages on one sync page. */
  partBytes: 1024 * 1024,
  /** Pages one list may span. */
  parts: 5000,
  /** Length of an item id or parent id. */
  idLength: 512,
  /** Length of an item label. */
  labelLength: 512,
  /** Members one item may carry. */
  membersPerItem: 10_000,
  /**
   * Members all the items of one page of a list may carry together. A page cut
   * to `partBytes` stays far below it; it bounds what a gateway writes for a
   * page that was not.
   */
  membersPerPart: 50_000,
  /** Length of a member identifier value. */
  identifierLength: 320,
} as const;

/** One page of the list of what exists in an account for a filterable field. */
export interface FilterListPublication {
  /** Path of the filterable field the list belongs to. */
  field: string;
  /** sha256 of the canonical item list, the same on every part. */
  digest: string;
  /** Position of this page in a list sent over several. */
  part: number;
  /** Whether this page is the last of the list. */
  final: boolean;
  items: FilterListItem[];
}

/**
 * What the gateway did with one page of a published list.
 *
 * - `staged` — stored; the list is not complete yet.
 * - `published` — stored, and the list it completes is now the current one.
 * - `current` — the gateway already holds the list with this digest.
 * - `out-of-sequence` — not the page the gateway expected next; send the list
 *   again from its first page.
 * - `superseded` — another publication of the same list started meanwhile.
 * - `undeclared` — the source's stored profile does not mark the field as one
 *   this gateway can filter on.
 * - `not-holder` — the list is shared by every device of the source and the
 *   publishing device does not hold the source's sync lease.
 */
export type FilterListOutcome =
  | "staged"
  | "published"
  | "current"
  | "out-of-sequence"
  | "superseded"
  | "undeclared"
  | "not-holder";

/** The gateway's answer for one page of a published list. */
export interface FilterListReceipt {
  field: string;
  digest: string;
  part: number;
  outcome: FilterListOutcome;
}
