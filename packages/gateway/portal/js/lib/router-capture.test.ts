// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { parseRoute } from "./router.js";

function route(pathname: string, search = "") {
  vi.stubGlobal("location", { pathname, search });
  return parseRoute();
}

afterEach(() => vi.unstubAllGlobals());

describe("capture portal route", () => {
  test("parses the capture page with or without a trailing slash", () => {
    expect(route("/portal/capture")).toEqual({ view: "capture", day: null });
    expect(route("/portal/capture/")).toEqual({ view: "capture", day: null });
  });

  test("a day query seeds the history; malformed values are ignored", () => {
    expect(route("/portal/capture", "?day=2026-03-01")).toEqual({
      view: "capture",
      day: "2026-03-01",
    });
    expect(route("/portal/capture", "?day=nonsense")).toEqual({ view: "capture", day: null });
    expect(route("/portal/capture", "?day=2026-99-99")).toEqual({
      view: "capture",
      day: "2026-99-99",
    });
  });

  test("a deeper capture path is not a page", () => {
    expect(route("/portal/capture/anything")).toEqual({ view: "search" });
  });
});
