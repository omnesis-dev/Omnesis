// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the compiler is shown about the install's sources.
 *
 * The section that matters here is the one naming sources a watch *cannot*
 * name. Leaving them out does not make the compiler refuse more carefully — it
 * makes it refuse for the wrong reason, because a source the operator is
 * already running looks, from a prompt listing only the watchable ones,
 * exactly like a source they have never connected.
 *
 * Fixture data is invented — no corpus content.
 */

import { describe, expect, it } from "vitest";

import { Ontology } from "../ontology/snapshot.js";
import { ontologyDigest } from "./ontology-digest.js";

function ontology(unwatchableSources: string[]): Ontology {
  return Ontology.parse({
    fingerprint: "an-install-fingerprint",
    sources: [
      {
        sourceId: "mailbox",
        providerId: "mailbox",
        semanticallyIndexed: true,
        profile: { documentTypes: ["email"], personRoles: ["sender"], metadataFields: [] },
      },
    ],
    unwatchableSources,
    analyticsTables: [],
    people: [],
  });
}

describe("the sources section", () => {
  it("names the ones a watch cannot name, and says they are already connected", () => {
    const digest = ontologyDigest(ontology(["fictional-ledger"]), []);

    expect(digest).toContain("- fictional-ledger");
    expect(digest).toContain("connected and indexed here");
    // The instruction that makes the refusal useful: the answer is not "go and
    // set this up", because it is set up.
    expect(digest).toContain("Never suggest connecting something that is already connected");
  });

  it("says nothing at all when the install has none", () => {
    // An empty heading is a claim about the install too, and the wrong one:
    // a compiler reading it would have a section to reason about that
    // describes nothing.
    expect(ontologyDigest(ontology([]), [])).not.toContain("connected and indexed here");
  });

  it("keeps the watchable sources describable beside them", () => {
    // The two lists answer different questions and both have to be readable:
    // this one is what a filter may name.
    const digest = ontologyDigest(ontology(["fictional-ledger"]), []);

    expect(digest).toContain("- mailbox (provider mailbox)");
    expect(digest).toContain("documentType: email");
  });
});

/**
 * What a field's own vocabulary tells the compiler.
 *
 * A source declares two things about a field beyond its type: the phrasings
 * that mean each of its values, and whether those values name a person. Both
 * only do work if the compiler is shown them — a phrasing the compiler never
 * sees has to be guessed against a list of values it does not resemble, and a
 * field whose values name people looks like any other attribute.
 */
describe("a field's declared vocabulary", () => {
  const sourceWithFields = Ontology.parse({
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
              valueAliases: {
                ticket: ["issue", "bug report"],
                "change-request": ["CR", "patch"],
              },
            },
            {
              path: "extra.assignee",
              type: "string",
              description: "Who the thread is assigned to.",
              identifiesPeople: true,
            },
            {
              path: "extra.reporter",
              type: "string",
              description: "Who opened the thread.",
              identifiesPeople: true,
              canonicalValues: ["self", "teammate"],
              valueAliases: { self: ["me", "myself"] },
            },
            {
              path: "extra.commentCount",
              type: "number",
              description: "How many comments the thread has.",
            },
          ],
        },
      },
    ],
    unwatchableSources: [],
    analyticsTables: [
      {
        tableName: "fictional_readings",
        displayName: "Fictional readings",
        description: "One reading per day.",
        sourceId: "fictional-tracker",
        primaryKey: ["reading_day"],
        semanticTimeColumn: "reading_day",
        columns: [
          { name: "reading_day", type: "DATE", description: "Day of the reading." },
          {
            name: "band",
            type: "VARCHAR",
            description: "How the reading compares to the usual range.",
            canonicalValues: ["low", "high"],
            valueAliases: { high: ["elevated", "above normal"] },
          },
        ],
      },
    ],
    people: [],
  });

  const digest = ontologyDigest(sourceWithFields, []);

  /** The one rendered line for a field or column, so a claim is about one line. */
  function line(fragment: string): string {
    return digest.split("\n").find((l) => l.includes(fragment))!;
  }

  it("says which phrasings mean which value, so a request's words map to one", () => {
    expect(line("extra.kind")).toContain(
      'spoken as: "CR", "patch" → change-request; "issue", "bug report" → ticket',
    );
    // The value list is what may be written; the phrasings are not.
    expect(line("extra.kind")).toContain("closed values: ticket | change-request");
  });

  it("orders the phrasings, because the digest heads a cached prompt", () => {
    expect(line("extra.kind").indexOf("→ change-request")).toBeLessThan(
      line("extra.kind").indexOf("→ ticket"),
    );
  });

  it("marks a field whose values name a person, so filtering on it is not an ordinary attribute", () => {
    expect(digest).toContain("metadata.extra.assignee: string (its values name a person)");
  });

  it("carries both marks on a field that is identity-bearing and spoken about", () => {
    expect(line("extra.reporter")).toContain("(its values name a person)");
    expect(line("extra.reporter")).toContain('spoken as: "me", "myself" → self');
  });

  it("leaves an ordinary field unadorned", () => {
    expect(line("extra.commentCount")).toContain("number — How many comments");
    expect(line("extra.commentCount")).not.toContain("its values name a person");
    expect(line("extra.commentCount")).not.toContain("spoken as");
  });

  it("carries an analytics column's phrasings too — the same declaration on the other plane", () => {
    expect(line("band VARCHAR")).toContain('spoken as: "elevated", "above normal" → high');
    expect(line("band VARCHAR")).toContain("canonical values: low | high");
  });
});
