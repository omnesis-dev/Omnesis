// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a recording ontology keeps, and — the part that carries — what it does
 * not.
 *
 * The digest is what decides whether a drifted watch may be re-stamped
 * unattended, so a recording that is too *narrow* would wave through a watch
 * whose meaning had moved. Every case here is one of the two mistakes: keeping
 * something that grows with the install (which would make the digest a second
 * fingerprint and heal nothing), or missing something a validation read (which
 * would let a change go unnoticed).
 */

import { describe, expect, it } from "vitest";

import { loadOntology } from "../universe/paths.js";
import { validateWatch } from "../validator/validate.js";
import { Ontology } from "./snapshot.js";
import { RecordingOntology } from "./recording.js";

const ontology = loadOntology();

/** The same ontology with one edit applied to its raw snapshot. */
function edited(edit: (snapshot: Record<string, unknown>) => void): Ontology {
  const copy = JSON.parse(JSON.stringify(ontology.snapshot)) as Record<string, unknown>;
  edit(copy);
  return new Ontology(copy as never);
}

/**
 * A watch that reads exactly one source and nothing else.
 *
 * It carries a fingerprint because a real drifted watch does, and because the
 * validator only *reads* the ontology's fingerprint when the watch declares
 * one — a fixture without it cannot tell whether the recording keeps it.
 */
function watchOn(sourceId: string, fingerprint: string): unknown {
  return {
    watch: {
      name: "reads-one-source",
      firing_policy: "stays_active",
      ontology_fingerprint: fingerprint,
      nodes: [
        {
          id: "seen",
          type: "source.document_event",
          filter: { source: sourceId, event: ["created"] },
          output_map: { doc_id: "$e.docId" },
        },
      ],
      sink: { input: "seen", output_map: { doc_id: "$n.seen.doc_id" } },
    },
  };
}

const FIRST_SOURCE = ontology.sourceIds()[0]!;

/** The slice a validation against this ontology consulted, as a digest. */
function surfaceOf(against: Ontology = ontology, sourceId: string = FIRST_SOURCE): string {
  const recording = new RecordingOntology(against);
  const result = validateWatch(watchOn(sourceId, against.fingerprint), recording);
  expect(
    result.valid,
    `the fixture watch does not validate: ${JSON.stringify(result.diagnostics)}`,
  ).toBe(true);
  return recording.digest();
}

describe("what a recording keeps", () => {
  it("does not move when the install grows somewhere the watch never looks", () => {
    // The case both live incidents were: a source publishes a profile nobody
    // has heard of, the install-wide fingerprint moves, and every watch stops.
    const grown = edited((snapshot) => {
      (snapshot["sources"] as unknown[]).push({
        sourceId: "fictional-ledger",
        providerId: "fictional",
        semanticallyIndexed: false,
        profile: { documentTypes: ["receipt"], personRoles: [], metadataFields: [] },
      });
    });

    expect(surfaceOf(grown)).toBe(surfaceOf());
  });

  it("moves when the source the watch reads is not the one it read before", () => {
    const changed = edited((snapshot) => {
      const sources = snapshot["sources"] as {
        sourceId: string;
        profile: Record<string, unknown>;
      }[];
      const source = sources.find((s) => s.sourceId === FIRST_SOURCE)!;
      // Additive from the install's point of view, and still valid for this
      // watch — which is exactly why validity is not the test.
      (source.profile["documentTypes"] as string[]).push("a-type-that-was-not-there");
    });

    expect(surfaceOf(changed)).not.toBe(surfaceOf());
  });

  it("ignores a source's provider, which appears on that source's first sync", () => {
    // `providerId` is read from the corpus rather than declared: it is the
    // source's own id until the source produces a document, and the real
    // provider afterwards. The install-wide fingerprint excludes it for that
    // reason, and a digest that kept it would hold a watch for review because
    // its source had synced.
    const synced = edited((snapshot) => {
      const sources = snapshot["sources"] as { sourceId: string; providerId: string }[];
      sources.find((source) => source.sourceId === FIRST_SOURCE)!.providerId = "a-real-provider";
    });

    expect(surfaceOf(synced)).toBe(surfaceOf());
  });

  it("ignores the fingerprint, which is the whole surface and would swamp it", () => {
    // Recording it would make every drift look like a change to whatever the
    // watch reads, which is the failure this exists to end.
    const restamped = edited((snapshot) => {
      snapshot["fingerprint"] = "a-different-fingerprint-entirely";
    });

    expect(surfaceOf(restamped)).toBe(surfaceOf());
  });

  it("records an absence as an answer", () => {
    // A source a watch names and the ontology does not have must not read the
    // same as one nobody asked about, or the source *appearing* would be
    // invisible.
    const asking = new RecordingOntology(ontology);
    asking.source("a-source-that-does-not-exist");

    expect(asking.digest()).not.toBe(new RecordingOntology(ontology).digest());
  });

  it("does not depend on the order the questions were asked in", () => {
    const forward = new RecordingOntology(ontology);
    forward.source(FIRST_SOURCE);
    forward.sourceIds();

    const backward = new RecordingOntology(ontology);
    backward.sourceIds();
    backward.source(FIRST_SOURCE);

    expect(forward.digest()).toBe(backward.digest());
  });
});

describe("the seam the recording depends on", () => {
  it("is the whole channel between a validation and an ontology", () => {
    // Nothing here is an `Ontology`. If a check ever reads past `OntologyReads`
    // — into `snapshot`, say — this stops compiling, and the digest stops being
    // a complete account of what a validation rested on long before anyone
    // notices a watch that was re-stamped when it should have been held.
    const answers = {
      fingerprint: ontology.fingerprint,
      source: (id: string) => ontology.source(id),
      sourceIds: () => ontology.sourceIds(),
      unwatchable: (id: string) => ontology.unwatchable(id),
      table: (name: string) => ontology.table(name),
      tableNames: () => ontology.tableNames(),
      person: (id: string) => ontology.person(id),
      canonicalPersonId: (id: string) => ontology.canonicalPersonId(id),
      metadataField: (id: string, path: string) => ontology.metadataField(id, path),
    };

    expect(validateWatch(watchOn(FIRST_SOURCE, ontology.fingerprint), answers).valid).toBe(true);
  });
});
