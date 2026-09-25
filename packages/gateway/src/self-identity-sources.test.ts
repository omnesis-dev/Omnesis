// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach } from "vitest";
import {
  indexSelfIdentitySources,
  listSelfIdentitySources,
  mergeSelfIdentitySources,
  resetSelfIdentitySources,
  resolveSelfIdentityAlias,
} from "./self-identity-sources.js";

const STRAVA = {
  sourceType: "strava-activities",
  aliasPrefix: "strava-athlete",
  accountPattern: "^\\d+$",
};
const APPLE = { sourceType: "apple-health", aliasPrefix: "apple-health-account" };
const GITHUB = { sourceType: "github", aliasPrefix: "github", accountPattern: "^([^@]+)" };

describe("self-identity-sources registry", () => {
  beforeEach(() => {
    resetSelfIdentitySources();
  });

  test("starts empty", () => {
    expect(listSelfIdentitySources()).toEqual([]);
  });

  test("merges a push by source type and lists in a stable order", () => {
    mergeSelfIdentitySources([STRAVA]);
    mergeSelfIdentitySources([APPLE]);
    expect(listSelfIdentitySources()).toEqual([APPLE, STRAVA]);
  });

  test("an empty push changes nothing — a collector hosting none of these sources is not the whole truth", () => {
    mergeSelfIdentitySources([STRAVA, GITHUB]);
    mergeSelfIdentitySources([]);
    expect(listSelfIdentitySources()).toEqual([GITHUB, STRAVA]);
  });

  test("a later declaration for one type replaces only that type", () => {
    mergeSelfIdentitySources([STRAVA, APPLE]);
    mergeSelfIdentitySources([{ ...STRAVA, accountPattern: "^\\d{1,12}$" }]);
    expect(listSelfIdentitySources()).toEqual([
      APPLE,
      { ...STRAVA, accountPattern: "^\\d{1,12}$" },
    ]);
  });
});

describe("resolveSelfIdentityAlias", () => {
  const hooks = indexSelfIdentitySources([STRAVA, APPLE, GITHUB]);

  test("returns null when no hook matches the source type", () => {
    expect(resolveSelfIdentityAlias(hooks, "gmail", "user@example.com")).toBeNull();
    expect(
      resolveSelfIdentityAlias(indexSelfIdentitySources([]), "apple-health", "local"),
    ).toBeNull();
  });

  test("forms the alias from the declared prefix + account", () => {
    expect(resolveSelfIdentityAlias(hooks, "apple-health", "local")).toBe(
      "apple-health-account:local",
    );
  });

  test("applies the declared accountPattern as a gate", () => {
    expect(resolveSelfIdentityAlias(hooks, "strava-activities", "43560449")).toBe(
      "strava-athlete:43560449",
    );
    expect(resolveSelfIdentityAlias(hooks, "strava-activities", "not-a-number")).toBeNull();
  });

  test("a capture group names the identity inside a scoped account id", () => {
    expect(resolveSelfIdentityAlias(hooks, "github", "octocat")).toBe("github:octocat");
    expect(resolveSelfIdentityAlias(hooks, "github", "octocat@acme-org")).toBe("github:octocat");
  });

  test("a pattern without a capture group still pairs on the whole account", () => {
    expect(resolveSelfIdentityAlias(hooks, "strava-activities", "7")).toBe("strava-athlete:7");
  });
});
