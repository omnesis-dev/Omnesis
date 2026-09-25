// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A URL naming a page that no longer exists.
 *
 * Someone has these bookmarked, and the router used to answer them with a view
 * name nothing renders — which reached the address bar as a page that had not
 * changed and a body that had. Falling through to the same place every other
 * unrecognised path lands is the honest answer: the URL is not a page here.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { parseRoute } from "./router.js";

function route(pathname: string) {
  vi.stubGlobal("location", { pathname, search: "" });
  return parseRoute();
}

afterEach(() => vi.unstubAllGlobals());

describe("a bookmarked URL for a retired page", () => {
  test("resolves like any other unknown path, not to a view nothing renders", () => {
    for (const path of [
      "/portal/triggers",
      "/portal/triggers/",
      "/portal/triggers/trg_1",
      "/portal/triggers/trg_1/firings/trf_1",
    ]) {
      expect(route(path), path).toEqual({ view: "search" });
    }
  });

  test("does not shadow the page that succeeded it", () => {
    // Watches are a different noun on a different path; the retired route must
    // not be reachable through them, nor they through it.
    expect(route("/portal/watches")).toMatchObject({ view: "watches", watchId: null });
  });
});
