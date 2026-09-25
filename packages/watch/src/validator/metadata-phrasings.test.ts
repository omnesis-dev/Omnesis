// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A predicate written with a phrasing rather than a value.
 *
 * A source declares the phrasings that mean each of its values, so a plan
 * comparing a field against one of them is a near miss with an exact answer.
 * Saying only that the value is not allowed leaves the repair to be guessed;
 * naming the value the phrasing means is the whole fix.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it } from "vitest";

import { Ontology } from "../ontology/snapshot.js";
import { validateWatch } from "./validate.js";

const ontology = Ontology.parse({
  fingerprint: "an-install-fingerprint",
  sources: [
    {
      sourceId: "fictional-tracker",
      providerId: "fictional-tracker",
      semanticallyIndexed: true,
      profile: {
        documentTypes: ["conversation"],
        personRoles: ["author"],
        metadataFields: [
          {
            path: "extra.kind",
            type: "string",
            description: "Which kind of thread this is.",
            allowedValues: ["ticket", "change-request"],
            valueAliases: { "change-request": ["CR", "patch"] },
          },
          {
            path: "extra.stage",
            type: "string",
            description: "Where the thread has got to.",
            canonicalValues: ["triage", "in-review"],
            valueAliases: { "in-review": ["being reviewed"] },
          },
        ],
      },
    },
  ],
  unwatchableSources: [],
  analyticsTables: [],
  people: [],
});

function watchComparing(path: string, value: string): unknown {
  return {
    watch: {
      name: "compares-a-field",
      firing_policy: "stays_active",
      nodes: [
        {
          id: "seen",
          type: "source.document_event",
          filter: {
            source: "fictional-tracker",
            event: ["created"],
            metadata: [{ path, op: "eq", value }],
          },
          output_map: { doc_id: "$e.docId" },
        },
      ],
      sink: { input: "seen", output_map: { doc_id: "$n.seen.doc_id" } },
    },
  };
}

function diagnosticFor(path: string, value: string) {
  return validateWatch(watchComparing(path, value), ontology).diagnostics.find(
    (d) => d.code === "METADATA_VALUE_NOT_ALLOWED" || d.code === "LINT_METADATA_VALUE_NONCANONICAL",
  );
}

describe("a predicate comparing a field against one of its phrasings", () => {
  it("names the value that phrasing means, on a closed field", () => {
    const diagnostic = diagnosticFor("extra.kind", "CR");

    expect(diagnostic?.code).toBe("METADATA_VALUE_NOT_ALLOWED");
    expect(diagnostic?.message).toContain("phrasing for 'change-request'");
    expect((diagnostic?.details as { aliasOf?: string } | undefined)?.aliasOf).toBe(
      "change-request",
    );
  });

  it("matches a phrasing however it was said — case and separators are not the saying", () => {
    expect(diagnosticFor("extra.kind", "cr")?.message).toContain("phrasing for 'change-request'");
    // The source boundary refuses two values claiming one phrase under this
    // same folding, so whatever resolves here is unambiguous by construction.
    expect(diagnosticFor("extra.stage", "being-reviewed")?.message).toContain(
      "phrasing for 'in-review'",
    );
    expect(diagnosticFor("extra.stage", "beingReviewed")?.message).toContain(
      "phrasing for 'in-review'",
    );
  });

  it("says the same on an open field, where the value may still match", () => {
    const diagnostic = diagnosticFor("extra.stage", "being reviewed");

    expect(diagnostic?.code).toBe("LINT_METADATA_VALUE_NONCANONICAL");
    expect(diagnostic?.message).toContain("phrasing for 'in-review'");
    expect((diagnostic?.details as { aliasOf?: string } | undefined)?.aliasOf).toBe("in-review");
  });

  it("adds nothing when the value is simply wrong rather than a phrasing", () => {
    const diagnostic = diagnosticFor("extra.kind", "not-a-thing");

    expect(diagnostic?.code).toBe("METADATA_VALUE_NOT_ALLOWED");
    expect(diagnostic?.message).not.toContain("phrasing for");
    expect((diagnostic?.details as { aliasOf?: string } | undefined)?.aliasOf).toBeUndefined();
  });

  it("says nothing at all when the plan already writes the value", () => {
    expect(
      validateWatch(watchComparing("extra.kind", "change-request"), ontology).diagnostics,
    ).toEqual([]);
  });
});
