// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { describe, test, expect } from "vitest";
import {
  experimentalLabelSuffix,
  extraPositionalArg,
  memberConfigForDescriptor,
  pathValueForCollector,
} from "./add.js";

describe("extraPositionalArg", () => {
  test("skips citty's duplicate named positional", () => {
    expect(extraPositionalArg("pi", ["pi", "/sessions"])).toBe("/sessions");
    expect(extraPositionalArg("pi", ["/sessions"])).toBe("/sessions");
  });
});

describe("pathValueForCollector", () => {
  test("leaves a remote collector's filesystem syntax for that collector to resolve", () => {
    expect(pathValueForCollector("  ~/sessions  ", "remote.example", { join, resolve })).toBe(
      "~/sessions",
    );
  });

  test("retains local path normalization when the collector shares this host", () => {
    expect(pathValueForCollector("~/sessions", hostname(), { join, resolve })).toBe(
      join(process.env.HOME ?? "", "/sessions"),
    );
  });
});

describe("experimentalLabelSuffix", () => {
  test("flags an experimental descriptor with a dim (experimental) tag", () => {
    const suffix = experimentalLabelSuffix(true);
    expect(suffix).toContain("(experimental)");
    // Rendered as a suffix — leads with a space so it appends cleanly.
    expect(suffix.startsWith(" ")).toBe(true);
  });

  test("returns an empty string for non-experimental descriptors", () => {
    expect(experimentalLabelSuffix(false)).toBe("");
    expect(experimentalLabelSuffix(undefined)).toBe("");
  });

  test("only the strict boolean true opts in (UnionDescriptor carries unknown)", () => {
    // Guards against a truthy-but-not-true value (e.g. a stray string) being
    // treated as experimental when the union descriptor's field is unknown.
    expect(experimentalLabelSuffix("true")).toBe("");
    expect(experimentalLabelSuffix(1)).toBe("");
    expect(experimentalLabelSuffix(null)).toBe("");
  });
});

describe("memberConfigForDescriptor", () => {
  /** A form field, named and scoped — the rest is what a form needs to render it. */
  const param = (name: string, scope: "source" | "member") =>
    ({ name, scope, label: name, type: "string" }) as const;

  test("routes a host-local value into member config and leaves the shared one alone", () => {
    expect(
      memberConfigForDescriptor(
        {
          params: [param("label", "source"), param("vaultPath", "member")],
          memberScopedParamNames: ["vaultPath"],
        },
        { label: "research", vaultPath: "/srv/vault" },
      ),
    ).toEqual({ params: { vaultPath: "/srv/vault" } });
  });

  test("an advanced host-local setting still reaches member config", () => {
    // The form's parameter list omits advanced settings, so it cannot be the
    // key: a value for one would otherwise land in the shared config, which
    // the gateway then refuses to store.
    expect(
      memberConfigForDescriptor(
        {
          params: [param("label", "source")],
          memberScopedParamNames: ["overrideDir"],
        },
        { label: "research", overrideDir: "/srv/override" },
      ),
    ).toEqual({ params: { overrideDir: "/srv/override" } });
  });

  test("a descriptor from an older gateway falls back to what its form declares", () => {
    expect(
      memberConfigForDescriptor(
        { params: [param("vaultPath", "member")] },
        { vaultPath: "/srv/vault" },
      ),
    ).toEqual({ params: { vaultPath: "/srv/vault" } });
  });

  test("no host-local value supplied means no member config at all", () => {
    expect(
      memberConfigForDescriptor(
        {
          params: [param("label", "source")],
          memberScopedParamNames: ["vaultPath"],
        },
        { label: "research" },
      ),
    ).toBeUndefined();
  });
});
