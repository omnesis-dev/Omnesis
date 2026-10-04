// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test } from "vitest";
import { linkDeclarationsBody } from "./http/schemas/admin.js";
import { applyCollectorDeclarationRoster } from "./collector-declaration-roster.js";
import {
  getSourceAttributions,
  resetSourceAttributions,
  setSourceAttributions,
  validateSourceAttributions,
} from "./source-attributions.js";

afterEach(() => {
  resetSourceAttributions();
  applyCollectorDeclarationRoster([]);
});

const legacyBundle = {
  canonicalizers: [],
  traversalHubPrefixes: [],
  fallbackRepresentationPrefixes: [],
  referenceOnlyPrefixes: [],
  patterns: [],
};

test("older collectors may omit attribution and newer declarations are bounded", () => {
  expect(linkDeclarationsBody.parse(legacyBundle).sourceAttributions).toBeUndefined();
  expect(getSourceAttributions()).toEqual({});
  expect(
    linkDeclarationsBody.safeParse({
      ...legacyBundle,
      sourceAttributions: { "demo-notes": "Data from example.org" },
    }).success,
  ).toBe(true);
  expect(
    linkDeclarationsBody.safeParse({
      ...legacyBundle,
      sourceAttributions: { "invalid:type": "Example" },
    }).success,
  ).toBe(false);
  expect(
    linkDeclarationsBody.safeParse({
      ...legacyBundle,
      sourceAttributions: { demo: "x".repeat(1025) },
    }).success,
  ).toBe(false);
});

test("siblings merge, identical declarations agree, and replacements preserve peers", () => {
  setSourceAttributions("first", { demo: "Provided by Demo", journal: "Provided by Journal" });
  setSourceAttributions("second", { demo: "Provided by Demo" });
  setSourceAttributions("first", {});
  expect(getSourceAttributions()).toEqual({ demo: "Provided by Demo" });
});

test("conflict preflight cannot alter the prior published generation", () => {
  setSourceAttributions("first", { demo: "Provided by Demo" });
  expect(() => validateSourceAttributions("second", { demo: "Changed" })).toThrow(
    "conflicting source attribution",
  );
  expect(() => setSourceAttributions("second", { demo: "Changed" })).toThrow(
    "conflicting source attribution",
  );
  expect(getSourceAttributions()).toEqual({ demo: "Provided by Demo" });
});

test("roster pruning removes disconnected collectors while preserving peers and admin", () => {
  setSourceAttributions("first", { demo: "Provided by Demo" });
  setSourceAttributions("second", { journal: "Provided by Journal" });
  setSourceAttributions("admin", { archive: "Provided by Archive" });
  applyCollectorDeclarationRoster(["second"]);
  expect(getSourceAttributions()).toEqual({
    journal: "Provided by Journal",
    archive: "Provided by Archive",
  });
  applyCollectorDeclarationRoster([]);
  expect(getSourceAttributions()).toEqual({ archive: "Provided by Archive" });
});

test("caller mutation does not change a declaration or its public snapshot", () => {
  const values = { demo: "Provided by Demo" };
  setSourceAttributions("first", values);
  values.demo = "Changed";
  const snapshot = getSourceAttributions();
  snapshot.demo = "Changed";
  expect(getSourceAttributions()).toEqual({ demo: "Provided by Demo" });
});
