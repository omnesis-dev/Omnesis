// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";
import {
  getFallbackUrlRepresentationSources,
  getReferenceOnlyUrlSources,
  getUrlTraversalHubSources,
  resetUrlGraphRoles,
  setExpectedUrlGraphRoleDeclarers,
  setLegacyUrlTraversalHubs,
  setUrlGraphRoles,
  urlGraphRolesReady,
} from "./url-graph-roles.js";

describe("URL graph role declarations", () => {
  afterEach(() => resetUrlGraphRoles());

  test("merges independent collector declarations instead of letting the last writer erase one", () => {
    setUrlGraphRoles("collector-a", ["history-a"], ["capture-a"], ["reference-a"]);
    setUrlGraphRoles("collector-b", ["history-b"], ["capture-b"], ["reference-b"]);

    expect(getUrlTraversalHubSources()).toEqual(new Set(["web", "history-a", "history-b"]));
    expect(getFallbackUrlRepresentationSources()).toEqual(
      new Set(["web", "capture-a", "capture-b"]),
    );
    expect(getReferenceOnlyUrlSources()).toEqual(new Set(["reference-a", "reference-b"]));
    expect(urlGraphRolesReady()).toBe(true);
  });

  test("a legacy hub declaration affects traversal but cannot mark target roles ready", () => {
    setLegacyUrlTraversalHubs("old-collector", ["legacy-history"]);

    expect(getUrlTraversalHubSources()).toContain("legacy-history");
    expect(urlGraphRolesReady()).toBe(false);
  });

  test("a declaration replaces only the same collector's contribution", () => {
    setUrlGraphRoles("collector-a", ["old-hub"], ["old-capture"], []);
    setUrlGraphRoles("collector-b", ["stable-hub"], [], ["stable-reference"]);
    setUrlGraphRoles("collector-a", ["new-hub"], [], []);

    expect(getUrlTraversalHubSources()).not.toContain("old-hub");
    expect(getUrlTraversalHubSources()).toContain("new-hub");
    expect(getUrlTraversalHubSources()).toContain("stable-hub");
    expect(getFallbackUrlRepresentationSources()).not.toContain("old-capture");
    expect(getReferenceOnlyUrlSources()).toContain("stable-reference");
  });

  test("mixed modern and legacy collectors stay unready until every declaration is complete", () => {
    setUrlGraphRoles("collector-a", [], ["capture-a"], ["reference-a"]);
    setLegacyUrlTraversalHubs("collector-b", ["history-b"]);
    expect(urlGraphRolesReady()).toBe(false);

    setUrlGraphRoles("collector-b", ["history-b"], [], []);
    expect(urlGraphRolesReady()).toBe(true);
  });

  test("the paired collector roster prevents a modern-first startup race", () => {
    setExpectedUrlGraphRoleDeclarers(["collector-a", "collector-b"]);
    setUrlGraphRoles("collector-a", [], ["capture-a"], ["reference-a"]);
    expect(urlGraphRolesReady()).toBe(false);

    setLegacyUrlTraversalHubs("collector-b", ["history-b"]);
    expect(urlGraphRolesReady()).toBe(false);

    setUrlGraphRoles("collector-b", ["history-b"], [], []);
    expect(urlGraphRolesReady()).toBe(true);
  });

  test("removing a collector from the roster removes its stale roles", () => {
    setUrlGraphRoles("collector-a", ["history-a"], ["capture-a"], []);
    setUrlGraphRoles("collector-b", ["history-b"], [], ["reference-b"]);
    setExpectedUrlGraphRoleDeclarers(["collector-a"]);

    expect(getUrlTraversalHubSources()).not.toContain("history-b");
    expect(getReferenceOnlyUrlSources()).not.toContain("reference-b");
  });

  test("a same-device legacy declaration replaces stale modern target roles", () => {
    setUrlGraphRoles("collector-a", [], ["capture-a"], ["reference-a"]);
    setLegacyUrlTraversalHubs("collector-a", ["history-a"]);

    expect(urlGraphRolesReady()).toBe(false);
    expect(getFallbackUrlRepresentationSources()).not.toContain("capture-a");
    expect(getReferenceOnlyUrlSources()).not.toContain("reference-a");
    expect(getUrlTraversalHubSources()).toContain("history-a");
  });
});
