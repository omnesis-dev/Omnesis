// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The example watch set: shapes an operator can copy, held to being real.
 *
 * These files exist to be read and adapted, which means the one thing that
 * must never happen to them is quiet rot. A committed example that no longer
 * validates is worse than none — someone copies it, the gateway refuses it, and
 * the first thing they learn about the system is that its documentation lies.
 *
 * Each is checked against the fixture ontology rather than a live install, so
 * the check runs anywhere. The one thing an example cannot carry is the
 * fingerprint — that belongs to the install it will run on, and every file says
 * so where the value goes.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { Ontology, validateWatch, watchDslSchema } from "@omnesis/watch";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The ontology these examples assume.
 *
 * Written out rather than loaded from a fixture, because it doubles as the
 * statement of what an example depends on: an install whose gmail source
 * declares `email` documents and these person roles will accept them, and one
 * that does not will not. A reader adapting an example can check their own
 * install against this list.
 */
const ontology = Ontology.parse({
  fingerprint: "examples",
  sources: [
    {
      sourceId: "gmail",
      providerId: "google",
      semanticallyIndexed: true,
      profile: {
        documentTypes: ["email", "attachment"],
        personRoles: ["sender", "recipient", "mentioned"],
        metadataFields: [
          { path: "tags", type: "string-array", description: "Gmail labels" },
          { path: "extra.threadId", type: "string", description: "conversation id" },
        ],
      },
    },
  ],
  analyticsTables: [],
  people: [],
});

/**
 * The node types the committed set is expected to demonstrate.
 *
 * Examples exist to be copied, and an operator copies the shape nearest to what
 * they want. A set that had drifted to five variations on one shape would
 * technically validate while leaving the other halves of the language — a
 * deadline, a recurring boundary — with nothing to start from.
 */
const SHAPES_COVERED = ["source.document_event", "source.time", "stateful.wait"] as const;

/** The fixture ontology's fingerprint, substituted for the placeholder. */
function withLocalFingerprint(dsl: unknown): unknown {
  const parsed = dsl as { watch: Record<string, unknown> };
  return { ...parsed, watch: { ...parsed.watch, ontology_fingerprint: ontology.fingerprint } };
}

const examples = readdirSync(here).filter((name) => name.endsWith(".json"));

/** Every node type the committed set uses. */
function shapesInSet(): Set<string> {
  const types = new Set<string>();
  for (const name of examples) {
    const raw = JSON.parse(readFileSync(join(here, name), "utf8")) as {
      watch: { nodes: { type: string }[] };
    };
    for (const node of raw.watch.nodes) types.add(node.type);
  }
  return types;
}

describe("the example watch set", () => {
  it("has examples in it", () => {
    // A glob that silently matches nothing would make every assertion below
    // vacuously true, which is the failure mode of every directory-driven test.
    expect(examples.length, "no example watches were found").toBeGreaterThan(0);
  });

  it("shows each of the shapes an operator has to start from", () => {
    const shapes = shapesInSet();
    for (const shape of SHAPES_COVERED) {
      expect(shapes, `no example demonstrates ${shape}`).toContain(shape);
    }
  });

  it("includes one that reaches a judge and one that never does", () => {
    // The economics an operator has to see side by side. Every example carrying
    // a judge would suggest a model call is the price of a watch, when the
    // cheapest and most useful watches never reach one.
    const judged: string[] = [];
    const free: string[] = [];
    for (const name of examples) {
      const raw = JSON.parse(readFileSync(join(here, name), "utf8")) as {
        watch: { nodes: { judge?: unknown }[] };
      };
      (raw.watch.nodes.some((node) => node.judge !== undefined) ? judged : free).push(name);
    }
    expect(judged, "no example shows what a semantic watch looks like").not.toHaveLength(0);
    expect(free, "no example shows a watch that costs nothing to run").not.toHaveLength(0);
  });

  for (const name of examples) {
    describe(name, () => {
      const raw: unknown = JSON.parse(readFileSync(join(here, name), "utf8"));

      it("validates against a real ontology", () => {
        const result = validateWatch(withLocalFingerprint(raw), ontology);
        const errors = result.diagnostics.filter((d) => d.severity === "error");
        expect(
          errors.map((d) => `${d.code} ${d.path}: ${d.message}`),
          `${name} does not validate — an example nobody can use is worse than none`,
        ).toEqual([]);
      });

      it("says where the install's fingerprint goes rather than inventing one", () => {
        // An example carrying a real fingerprint would be copied and refused,
        // and the refusal would look like a bug in the runtime rather than a
        // value the operator has to fill in.
        const fingerprint = (raw as { watch: { ontology_fingerprint?: string } }).watch
          .ontology_fingerprint;
        expect(fingerprint, `${name} carries no fingerprint placeholder`).toContain("REPLACE");
        expect(fingerprint).toContain("/admin/watch/ontology");
      });

      it("explains itself to whoever copies it", () => {
        const parsed = watchDslSchema.parse(withLocalFingerprint(raw));
        expect(parsed.watch.nl_query, `${name} does not say what it is for`).toBeTruthy();
      });
    });
  }
});
