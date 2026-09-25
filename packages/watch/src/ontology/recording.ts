// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * An ontology that remembers what was asked of it.
 *
 * Validate a watch against one of these and {@link RecordingOntology.digest}
 * hashes exactly the entries the validation consulted — the source profiles it
 * resolved a filter against, the tables a SQL node reads, the people a
 * predicate names. Nothing else: an install can grow a source, a table, or
 * fifty thousand contacts without moving it.
 *
 * That is the difference between this and the install-wide fingerprint, and
 * why both exist. The fingerprint is one hash over the whole declared surface,
 * so it moves whenever *anything* does — which makes it a fine alarm ("the
 * world is not the one you were checked against") and a useless answer to the
 * question that follows it ("did the part I depend on move?"). This answers
 * that one, and it answers it as a proof rather than an estimate: two
 * validations over byte-identical consulted entries cannot reach different
 * conclusions, because there is nothing else for a conclusion to be drawn
 * from. `OntologyReads` is what makes that true — it is the whole channel
 * between an ontology and a validation, so recording it records everything.
 *
 * Consequences worth knowing before relying on the digest:
 *
 * - **Entries are recorded whole**, because the validator reads them whole — a
 *   source through the same declared projection the fingerprint hashes, so the
 *   two agree about what changing a source means. A
 *   new column on a table a watch already reads changes the digest even though
 *   the watch never names that column — correctly so: `SELECT *` projects it,
 *   and a new metadata field can carry value aliases that widen what an
 *   existing filter matches.
 * - **An absence is a recorded answer.** A source a watch names and the
 *   ontology does not have records `null`, so the source *appearing* is a
 *   change, not a coincidence.
 * - **The fingerprint is not recorded.** It is the hash of everything; keeping
 *   it would make every drift look like a change to whatever the watch reads.
 * - **This is the validator's view, not the runtime's.** The engine also reads
 *   the ontology — it re-canonicalizes every person id on every arriving
 *   document, ids no validation ever sees — so the guarantee is precisely that
 *   a *validation* over identical consulted entries reaches identical
 *   conclusions. That is the right scope for the caller this exists for: the
 *   runtime's extra reads are of people, and people are deliberately outside
 *   the fingerprint, so they never produce the drift this is consulted about.
 */

import { createHash } from "node:crypto";
import { canonicalJson, declaredSource } from "./canonical.js";
import type {
  AnalyticsTableSnapshot,
  DocumentMetadataFieldSpecSnapshot,
  OntologyReads,
  PersonDirectoryEntry,
  SourceOntology,
} from "./snapshot.js";

export class RecordingOntology implements OntologyReads {
  /** Keyed by the question asked, holding the answer given. */
  private readonly consulted = new Map<string, unknown>();

  constructor(private readonly inner: OntologyReads) {}

  get fingerprint(): string {
    return this.inner.fingerprint;
  }

  source(sourceId: string): SourceOntology | undefined {
    const found = this.inner.source(sourceId);
    // The declared half only, matching what the install-wide fingerprint
    // hashes. The raw entry also carries `providerId`, which appears on a
    // source's first sync — recording it would hold a watch for review because
    // its source produced a document.
    this.consulted.set(`source:${sourceId}`, found === undefined ? null : declaredSource(found));
    return found;
  }

  sourceIds(): string[] {
    return this.keep("sourceIds", this.inner.sourceIds());
  }

  unwatchable(sourceId: string): boolean {
    return this.keep(`unwatchable:${sourceId}`, this.inner.unwatchable(sourceId));
  }

  table(tableName: string): AnalyticsTableSnapshot | undefined {
    return this.keep(`table:${tableName}`, this.inner.table(tableName));
  }

  tableNames(): string[] {
    return this.keep("tableNames", this.inner.tableNames());
  }

  person(personId: string): PersonDirectoryEntry | undefined {
    return this.keep(`person:${personId}`, this.inner.person(personId));
  }

  canonicalPersonId(personId: string): string | undefined {
    // The answer rather than the chain that produced it. A merge that reroutes
    // the hops without moving the surviving id leaves every watch naming this
    // person meaning precisely what it meant before.
    return this.keep(`canonicalPerson:${personId}`, this.inner.canonicalPersonId(personId));
  }

  metadataField(sourceId: string, path: string): DocumentMetadataFieldSpecSnapshot | undefined {
    return this.keep(`metadataField:${sourceId}:${path}`, this.inner.metadataField(sourceId, path));
  }

  /**
   * A hash over everything consulted, in an order that is a function of the
   * questions rather than of when they were asked.
   *
   * Sorted because the validator's traversal order is its own business: two
   * runs over the same watch and the same ontology must agree, and a check
   * reordered inside the validator must not read as the world having moved.
   */
  digest(): string {
    const entries = [...this.consulted.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonicalJson(value)}`);
    return createHash("sha256")
      .update(`{${entries.join(",")}}`)
      .digest("hex")
      .slice(0, 32);
  }

  private keep<T>(key: string, value: T): T {
    // `undefined` and `null` both canonicalize to "null", so an absence is
    // recorded as an answer rather than as a question never asked.
    this.consulted.set(key, value ?? null);
    return value;
  }
}
