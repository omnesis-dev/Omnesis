// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  PUBLIC_NPM_PUBLISH_ENV,
  assertPublishPolicy,
  isNpmjsRegistry,
  normalizePublishAccess,
} from "./publish-policy.mjs";

describe("release publish policy", () => {
  test("defaults to restricted access", () => {
    expect(normalizePublishAccess(undefined)).toBe("restricted");
  });

  test("rejects unknown access values", () => {
    expect(() => normalizePublishAccess("private")).toThrow(/public\|restricted/);
  });

  test("recognizes npmjs registry URLs", () => {
    expect(isNpmjsRegistry("https://registry.npmjs.org")).toBe(true);
    expect(isNpmjsRegistry("http://localhost:4873")).toBe(false);
  });

  test("blocks public npmjs publishes without the release override", () => {
    expect(() =>
      assertPublishPolicy({
        registry: "https://registry.npmjs.org",
        access: "public",
        env: {},
      }),
    ).toThrow(/Public npmjs publishes are blocked/);
  });

  test("allows public npmjs publishes only with the explicit release override", () => {
    expect(() =>
      assertPublishPolicy({
        registry: "https://registry.npmjs.org",
        access: "public",
        env: { [PUBLIC_NPM_PUBLISH_ENV]: "1" },
      }),
    ).not.toThrow();
  });

  test("allows dry-run and local-registry public publishes", () => {
    expect(() =>
      assertPublishPolicy({
        registry: "https://registry.npmjs.org",
        access: "public",
        dryRun: true,
        env: {},
      }),
    ).not.toThrow();
    expect(() =>
      assertPublishPolicy({
        registry: "http://localhost:4873",
        access: "public",
        env: {},
      }),
    ).not.toThrow();
  });
});
