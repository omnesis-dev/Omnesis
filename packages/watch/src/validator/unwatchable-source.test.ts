// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Two ways a source can be missing, and why they must not share a sentence.
 *
 * On a real install substantially more sources are connected and indexed than
 * publish a document-event profile, so "the ontology has no such source" is
 * far more often "you already run this and it cannot be watched yet" than it
 * is "you have not set this up". The two answers owed have nothing in common:
 * one is a connector to add, the other is nothing to add at all.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it } from "vitest";

import { loadOntology } from "../universe/paths.js";
import { Ontology } from "../ontology/snapshot.js";
import { validateWatch } from "./validate.js";

const base = loadOntology();

/** The fixture ontology, told that these sources exist and cannot be watched. */
function knowing(...unwatchableSources: string[]): Ontology {
  const snapshot = JSON.parse(JSON.stringify(base.snapshot)) as Record<string, unknown>;
  snapshot["unwatchableSources"] = unwatchableSources;
  return new Ontology(snapshot as never);
}

function watchOn(sourceId: string): unknown {
  return {
    watch: {
      name: "names-a-source",
      firing_policy: "stays_active",
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

function codesFor(sourceId: string, ontology: Ontology): string[] {
  return validateWatch(watchOn(sourceId), ontology)
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.code);
}

describe("a source a watch cannot name", () => {
  it("says so differently when the install already has it", () => {
    expect(codesFor("a-connected-ledger", knowing("a-connected-ledger"))).toContain(
      "SOURCE_NOT_WATCHABLE",
    );
  });

  it("still says the source is unknown when the install really does not have it", () => {
    expect(codesFor("a-source-nobody-runs", knowing("a-connected-ledger"))).toContain(
      "SOURCE_UNKNOWN",
    );
  });

  it("never says both about one source", () => {
    // They are answers to the same question, and a watch told both would leave
    // its owner to decide which one to believe.
    for (const ontology of [knowing("a-connected-ledger"), knowing()]) {
      const codes = codesFor("a-connected-ledger", ontology);
      expect(codes.filter((c) => c.startsWith("SOURCE_"))).toHaveLength(1);
    }
  });

  it("reads an install that declares nothing unwatchable the way it always did", () => {
    // The field defaults to empty, so an ontology written before it existed
    // parses and behaves exactly as before.
    const older = JSON.parse(JSON.stringify(base.snapshot)) as Record<string, unknown>;
    delete older["unwatchableSources"];
    const parsed = Ontology.parse(older);

    expect(parsed.snapshot.unwatchableSources).toEqual([]);
    expect(codesFor("a-connected-ledger", parsed)).toContain("SOURCE_UNKNOWN");
  });
});
