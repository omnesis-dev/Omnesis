// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The search page's address carries its query, so a link can open a search.

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { parseRoute } from "./router.js";

function route(pathname: string, search = "") {
  vi.stubGlobal("location", { pathname, search });
  return parseRoute();
}

afterEach(() => vi.unstubAllGlobals());

describe("the search route", () => {
  test("reads the query from ?q=", () => {
    expect(route("/portal/search", "?q=dentist%20next%20month")).toEqual({
      view: "search",
      query: "dentist next month",
    });
    expect(route("/portal/search/", "?q=invoice+from+March")).toEqual({
      view: "search",
      query: "invoice from March",
    });
  });

  test("opens empty without one", () => {
    expect(route("/portal/search")).toEqual({ view: "search", query: "" });
  });
});
