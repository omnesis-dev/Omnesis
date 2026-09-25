// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";
import {
  invalidateLinkDeclarationBundle,
  linkDeclarationBundlesReady,
  markLinkDeclarationBundleReady,
  resetLinkDeclarationBundleReadiness,
  setExpectedLinkDeclarationKeys,
} from "./link-declaration-readiness.js";

afterEach(() => resetLinkDeclarationBundleReadiness());

describe("atomic link-declaration bundle readiness", () => {
  test("requires at least one connected collector even when admin metadata exists", () => {
    markLinkDeclarationBundleReady("admin");
    expect(linkDeclarationBundlesReady()).toBe(false);
  });

  test("waits until every active collector has published one complete bundle", () => {
    setExpectedLinkDeclarationKeys(["collector-a", "collector-b"]);
    markLinkDeclarationBundleReady("collector-a");
    expect(linkDeclarationBundlesReady()).toBe(false);

    markLinkDeclarationBundleReady("collector-b");
    expect(linkDeclarationBundlesReady()).toBe(true);
  });

  test("an old per-field update invalidates that collector's complete generation", () => {
    setExpectedLinkDeclarationKeys(["collector-a"]);
    markLinkDeclarationBundleReady("collector-a");
    expect(linkDeclarationBundlesReady()).toBe(true);

    invalidateLinkDeclarationBundle("collector-a");
    expect(linkDeclarationBundlesReady()).toBe(false);
  });

  test("prunes a revoked collector so it cannot hold readiness open", () => {
    setExpectedLinkDeclarationKeys(["collector-a", "collector-b"]);
    markLinkDeclarationBundleReady("collector-a");
    markLinkDeclarationBundleReady("collector-b");

    setExpectedLinkDeclarationKeys(["collector-a"]);
    expect(linkDeclarationBundlesReady()).toBe(true);

    setExpectedLinkDeclarationKeys(["collector-b"]);
    expect(linkDeclarationBundlesReady()).toBe(false);
  });
});
