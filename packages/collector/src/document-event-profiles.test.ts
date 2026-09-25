// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the collector actually publishes to `POST /admin/source-document-profiles`.
 *
 * These run against the REAL registry — the provider packages discovered from
 * the collector's own dependencies — rather than hand-built fixtures, because
 * the failure being guarded against is a source whose profile never reaches the
 * gateway at all. A source missing from the published set is invisible to watch
 * compilation, which then reaches for the nearest source it does know and
 * builds a watch over the wrong corpus. Nothing about that fails loudly.
 */

import { describe, test, expect } from "vitest";
import { validateDocumentEventProfile } from "@omnesis/source-sdk";

import { allDefinitions } from "./source-descriptors.js";
import { collectDocumentEventProfiles } from "./source-manager.js";

const published = collectDocumentEventProfiles(allDefinitions);
const bySourceType = new Map(published.map((entry) => [entry.sourceType, entry.profile]));

describe("published document-event profiles", () => {
  test("every published profile satisfies the source contract", () => {
    for (const entry of published) {
      expect(() =>
        validateDocumentEventProfile(entry.profile, `source '${entry.sourceType}'`),
      ).not.toThrow();
    }
  });

  test("a source type is published at most once", () => {
    expect(bySourceType.size).toBe(published.length);
  });

  // Transcript ingestion still works when a profile is absent, but Watch
  // compilation then guesses another source shape. Pin every agent transcript
  // source in the published catalog so that failure cannot stay silent.
  test.each(["openclaw", "hermes", "pi", "claude-code", "codex"])(
    "the %s transcripts publish a profile",
    (sourceType) => {
      const profile = bySourceType.get(sourceType);
      expect(profile, `${sourceType} publishes no document-event profile`).toBeDefined();
      expect(profile!.documentTypes).toContain("conversation");
      expect(profile!.personRoles).toContain("participant");
      expect((profile!.metadataFields ?? []).length).toBeGreaterThan(0);
    },
  );

  test("local coding-session profiles name their own agent", () => {
    const expected = new Map([
      ["pi", "Pi"],
      ["claude-code", "Claude Code"],
      ["codex", "Codex"],
    ]);
    for (const [sourceType, agentName] of expected) {
      const profile = bySourceType.get(sourceType)!;
      expect(
        profile.metadataFields?.find((field) => field.path === "extra.agent")?.allowedValues,
      ).toEqual([agentName]);
    }
  });

  test("the two agent harnesses are told apart by more than their name", () => {
    // Once the catalog hides source names, two sources declaring the same
    // document types, roles and field paths are indistinguishable and the
    // compiler refuses to guess between them. These two differ on both counts:
    // each names its own agent, and only the harness that reports a chat's
    // display name and shape declares those fields.
    const openclaw = bySourceType.get("openclaw")!;
    const hermes = bySourceType.get("hermes")!;
    const agentValues = (profile: typeof openclaw): string[] =>
      profile.metadataFields?.find((f) => f.path === "extra.agent")?.allowedValues ?? [];
    expect(agentValues(openclaw)).toEqual(["OpenClaw"]);
    expect(agentValues(hermes)).toEqual(["Hermes"]);

    const paths = (profile: typeof openclaw): string[] =>
      (profile.metadataFields ?? []).map((f) => f.path).sort();
    expect(paths(openclaw)).not.toEqual(paths(hermes));
  });

  test.each(["openclaw", "hermes"])(
    "the %s source is not something a collector offers to add",
    (sourceType) => {
      // Carrying the package in the registry is what publishes the profile,
      // but these sources are pushed to the gateway rather than run here. The
      // `source.descriptors` handler drops `gatewayHosted` descriptors, so
      // that flag must stay set or the pair would appear in the "Add source"
      // picker as accounts an operator could connect. Asserted on the
      // definition rather than the descriptor list, which is additionally
      // gated by the experimental flag and so varies with the environment.
      const definition = allDefinitions.find((d) => d.type === "source" && d.id === sourceType) as
        | { gatewayHosted?: boolean; execution?: string; create?: unknown }
        | undefined;
      expect(definition, `${sourceType} has no definition`).toBeDefined();
      expect(definition!.gatewayHosted).toBe(true);
      // And nothing here drives it, which is why it declares no factory at all
      // rather than one that returns an empty page forever.
      expect(definition!.execution).toBe("external");
      expect(definition!.create).toBeUndefined();
    },
  );
});
