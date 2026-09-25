// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { CAPABILITY_ROLES, CAPABILITY_METADATA } from "./capabilities.js";

describe("CAPABILITY_METADATA", () => {
  it("has an entry for every capability role", () => {
    for (const role of CAPABILITY_ROLES) {
      const meta = CAPABILITY_METADATA[role];
      expect(meta, role).toBeDefined();
      expect(meta.role, role).toBe(role);
    }
  });

  it("does not carry metadata for unknown roles", () => {
    const metaRoles = Object.keys(CAPABILITY_METADATA).sort();
    expect(metaRoles).toEqual([...CAPABILITY_ROLES].sort());
  });

  it("gives every capability a valid icon slug", () => {
    for (const role of CAPABILITY_ROLES) {
      const meta = CAPABILITY_METADATA[role];
      // Icon slugs are kebab-case Lucide names (e.g. "scan-text").
      expect(meta.icon, `${role}.icon`).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("exposes the privacy reviewer as an independent core capability", () => {
    expect(CAPABILITY_METADATA["privacy-reviewer"]).toMatchObject({
      role: "privacy-reviewer",
      section: "core",
    });
    expect(CAPABILITY_METADATA["privacy-reviewer"].experimental).not.toBe(true);
  });

  it("groups the reasoning capabilities under cognition, the substrate under core", () => {
    // The section split is "does this component interpret what the user's
    // records mean", not "does it call a model" — embedding and OCR do, and
    // stay in core. The interactive agent reasons over the corpus, so it
    // belongs with the background one even though a person triggers it.
    const bySection = (section: "core" | "cognition") =>
      CAPABILITY_ROLES.filter((r) => CAPABILITY_METADATA[r].section === section).sort();

    expect(bySection("cognition")).toEqual([
      "agent",
      "background-agent",
      "brief-judge",
      "entailment-verifier",
      "watch-judge",
    ]);
    expect(bySection("core")).toEqual(["embedder", "ocr", "privacy-reviewer", "transcriber"]);
  });
});
