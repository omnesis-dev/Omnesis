// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { parseRoute } from "./router.js";

function route(pathname: string) {
  vi.stubGlobal("location", { pathname, search: "" });
  return parseRoute();
}

afterEach(() => vi.unstubAllGlobals());

describe("recordings portal route", () => {
  test("the list, with or without a trailing slash", () => {
    expect(route("/portal/recordings")).toEqual({ view: "recordings", recordingId: null });
    expect(route("/portal/recordings/")).toEqual({ view: "recordings", recordingId: null });
  });

  test("one recording by its id", () => {
    const id = "8f14e45f-ceea-467a-9575-7d5b2b2a5e11";
    expect(route(`/portal/recordings/${id}`)).toEqual({ view: "recordings", recordingId: id });
    expect(route(`/portal/recordings/${id}/`)).toEqual({ view: "recordings", recordingId: id });
  });

  test("an id that cannot be decoded falls back to the list; a deeper path is not a page", () => {
    expect(route("/portal/recordings/%E0%A4%A")).toEqual({ view: "recordings", recordingId: null });
    expect(route("/portal/recordings/a/b")).toEqual({ view: "search" });
  });
});
