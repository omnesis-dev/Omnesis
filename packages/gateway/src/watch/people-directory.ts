// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The person directory the Watch ontology validates against.
 *
 * The runtime re-reads it on every evaluation pass, because a watch naming
 * someone who joined a moment ago must validate on the very next pass. On a
 * real install that is tens of thousands of rows read, mapped and hashed every
 * few seconds, so the gateway runs this read on an io worker
 * (`io.watchPeopleDirectory`) and the worker sends the rows back only when
 * their hash differs from the one the caller already holds. In the steady state
 * the main thread receives a hash and nothing else.
 *
 * Kept free of the rest of the Watch runtime so that the io worker, which
 * imports it, does not load the DSL to run one query.
 */

import { createHash } from "node:crypto";
import type { Db } from "../data/types.js";

/** One person as the ontology snapshot carries it. */
export interface PeopleDirectoryEntry {
  readonly id: string;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly isSelf: boolean;
  readonly mergedInto?: string;
}

/**
 * One read of the directory: its content hash, and the rows themselves unless
 * the caller already holds rows with that hash.
 */
export interface PeopleDirectoryRead {
  readonly hash: string;
  readonly people: readonly PeopleDirectoryEntry[] | null;
}

/** Reads the directory, answering with a hash alone when `knownHash` still matches. */
export type PeopleDirectoryReader = (knownHash: string | null) => Promise<PeopleDirectoryRead>;

/**
 * Ids, canonical names and merge targets, ordered by id.
 *
 * Not aliases: a directory exists so a compiler can turn a name into an id, and
 * the alias table is the corpus's own record of how a person has been
 * addressed — copying it into something plans are validated against would put
 * a great deal of personal data where it does not need to be.
 */
export function peopleDirectory(db: Db): PeopleDirectoryEntry[] {
  return db
    .prepare<
      [],
      { id: string; canonical_name: string; is_self: number; merged_into: string | null }
    >("SELECT id, canonical_name, is_self, merged_into FROM people ORDER BY id")
    .all()
    .map((row) => ({
      id: row.id,
      canonicalName: row.canonical_name,
      aliases: [],
      isSelf: row.is_self === 1,
      ...(row.merged_into === null ? {} : { mergedInto: row.merged_into }),
    }));
}

/** A content hash of the directory: equal directories hash equally. */
function peopleDirectoryHash(people: readonly PeopleDirectoryEntry[]): string {
  return createHash("sha256").update(JSON.stringify(people)).digest("hex").slice(0, 32);
}

/** The directory and its hash, leaving the rows out when the caller already has them. */
export function readPeopleDirectory(db: Db, knownHash: string | null): PeopleDirectoryRead {
  const people = peopleDirectory(db);
  const hash = peopleDirectoryHash(people);
  return { hash, people: hash === knownHash ? null : people };
}
