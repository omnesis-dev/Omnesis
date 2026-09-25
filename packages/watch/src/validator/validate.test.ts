// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Behaviour of the validator itself, as distinct from what it says about any
 * particular watch — that is the goldens' job (`invalid-goldens.test.ts`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadOntology, universeDir } from "../universe/paths.js";
import { validateWatch } from "./validate.js";

const ontology = loadOntology();

function example(name: string): unknown {
  return JSON.parse(readFileSync(join(universeDir(), "watches", `${name}.json`), "utf8"));
}

describe("validateWatch", () => {
  it("rejects anything that is not a watch document", () => {
    for (const input of [null, 42, "watch", [], {}, { watch: {} }]) {
      const result = validateWatch(input, ontology);
      expect(result.valid).toBe(false);
      expect(result.diagnostics.every((d) => d.code === "DSL_SCHEMA_INVALID")).toBe(true);
    }
  });

  it("reports schema failures without attempting semantic checks on rubble", () => {
    const result = validateWatch({ watch: { name: "x", firing_policy: "sometimes" } }, ontology);
    // The bad firing policy, plus the missing `nodes` and `sink`.
    expect(result.diagnostics.map((d) => d.path)).toEqual([
      "/watch/firing_policy",
      "/watch/nodes",
      "/watch/sink",
    ]);
    expect(result.diagnostics.every((d) => d.code === "DSL_SCHEMA_INVALID")).toBe(true);
  });

  it("is deterministic — the same input yields byte-identical diagnostics", () => {
    const watch = JSON.parse(
      readFileSync(join(universeDir(), "invalid", "inputs-point-nowhere.json"), "utf8"),
    ) as unknown;
    const first = validateWatch(watch, ontology);
    const second = validateWatch(watch, ontology);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("orders diagnostics by JSON path so a golden does not depend on walk order", () => {
    const watch = JSON.parse(
      readFileSync(join(universeDir(), "invalid", "inputs-point-nowhere.json"), "utf8"),
    ) as unknown;
    const paths = validateWatch(watch, ontology).diagnostics.map((d) => d.path);
    expect([...paths].sort()).toEqual(paths);
  });

  it("keeps reporting after the first error rather than stopping at it", () => {
    const watch = JSON.parse(
      readFileSync(join(universeDir(), "invalid", "reference-targets-do-not-exist.json"), "utf8"),
    ) as unknown;
    expect(validateWatch(watch, ontology).diagnostics.length).toBeGreaterThan(3);
  });

  it("pauses a watch compiled against a different ontology rather than running it", () => {
    const watch = example("mum-call-rhythm-stopped") as { watch: { ontology_fingerprint: string } };
    watch.watch.ontology_fingerprint = "some-older-snapshot";
    const result = validateWatch(watch, ontology);
    expect(result.diagnostics.map((d) => d.code)).toContain("ONTOLOGY_FINGERPRINT_MISMATCH");
  });

  it("accepts a watch that declares no fingerprint at all", () => {
    const watch = example("mum-call-rhythm-stopped") as { watch: Record<string, unknown> };
    delete watch.watch.ontology_fingerprint;
    expect(validateWatch(watch, ontology).valid).toBe(true);
  });
});
