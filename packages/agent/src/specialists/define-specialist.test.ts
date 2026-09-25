// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { allToolPorts } from "../tools/builtin-tools.fixture.js";
import { buildBuiltinTools } from "../tools/registry.js";
import {
  BUILTIN_SPECIALISTS,
  createBuiltinSpecialistRegistry,
  defineSpecialist,
  SpecialistRegistry,
  UnknownSpecialistError,
} from "./index.js";

describe("specialist registry", () => {
  it("resolves each v1 built-in by name to its prompt + role + tools", () => {
    const registry = createBuiltinSpecialistRegistry();
    for (const name of ["history-sweep", "source-digest", "citation-verifier"]) {
      const s = registry.resolve(name);
      expect(s.name).toBe(name);
      expect(s.systemPrompt.length).toBeGreaterThan(0);
      // A specialist names a model ROLE only — never a backend/model (frozen
      // constraint). Deep Research runs every specialist on the agent role.
      expect(s.modelRole).toBe("agent");
    }
  });

  it("exposes the v1 built-ins including the Deep Research planner", () => {
    const registry = createBuiltinSpecialistRegistry();
    expect(registry.names().sort()).toEqual(
      ["citation-verifier", "history-sweep", "research-planner", "source-digest"].sort(),
    );
    expect(BUILTIN_SPECIALISTS).toHaveLength(4);
  });

  it("fails cleanly on an unknown specialist — never a silent generic run", () => {
    const registry = createBuiltinSpecialistRegistry();
    expect(() => registry.resolve("does-not-exist")).toThrow(UnknownSpecialistError);
    try {
      registry.resolve("does-not-exist");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownSpecialistError);
      // The error names the bad input AND the available alternatives.
      expect((err as UnknownSpecialistError).specialist).toBe("does-not-exist");
      expect((err as UnknownSpecialistError).known).toContain("history-sweep");
    }
  });

  it("every built-in's default tool allowlist contains only read tools", () => {
    // Asked of the live catalog rather than a list of names kept here: a
    // specialist that named a tool which later grew a write path would still
    // pass a name check, and this is the assertion that is supposed to notice.
    const writers = new Set(
      buildBuiltinTools({ ports: allToolPorts(), experimental: true })
        .filter((tool) => tool.mutates === true)
        .map((tool) => tool.name),
    );
    expect(writers.size).toBeGreaterThan(0);
    const registry = createBuiltinSpecialistRegistry();
    for (const s of registry.list()) {
      for (const tool of s.defaultTools ?? []) {
        expect([tool, writers.has(tool)]).toEqual([tool, false]);
      }
      // A specialist must not pre-grant the spawn tool to itself either.
      expect(s.defaultTools ?? []).not.toContain("spawn_subagent");
    }
  });

  it("keeps SQL out of the default reader specialists", () => {
    const registry = createBuiltinSpecialistRegistry();
    expect(registry.resolve("history-sweep").defaultTools).not.toContain("run_sql");
    expect(registry.resolve("source-digest").defaultTools).not.toContain("run_sql");
    expect(registry.resolve("citation-verifier").defaultTools).not.toContain("run_sql");
  });

  it("rejects a registry with duplicate specialist names", () => {
    const dup = defineSpecialist({
      name: "history-sweep",
      systemPrompt: "dup",
      modelRole: "agent",
    });
    expect(() => new SpecialistRegistry([...BUILTIN_SPECIALISTS, dup])).toThrow(/duplicate/);
  });

  it("has() reports membership without throwing", () => {
    const registry = createBuiltinSpecialistRegistry();
    expect(registry.has("source-digest")).toBe(true);
    expect(registry.has("nope")).toBe(false);
  });
});
