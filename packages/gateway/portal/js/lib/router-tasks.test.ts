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

describe("tasks portal route", () => {
  test("the bare path opens Today", () => {
    expect(route("/portal/tasks")).toEqual({ view: "tasks", taskView: "today" });
    expect(route("/portal/tasks/")).toEqual({ view: "tasks", taskView: "today" });
  });

  test("each journal view is addressable", () => {
    for (const view of ["today", "month", "future", "anytime", "waiting", "suggested", "done"]) {
      expect(route(`/portal/tasks/${view}`)).toEqual({ view: "tasks", taskView: view });
    }
  });

  test("?task= opens one task on the addressed view", () => {
    expect(route("/portal/tasks", "?task=loop_abc")).toEqual({
      view: "tasks",
      taskView: "today",
      focusTaskId: "loop_abc",
    });
    expect(route("/portal/tasks/anytime", "?task=")).toEqual({ view: "tasks", taskView: "anytime" });
  });

  test("an unknown view falls back to Today", () => {
    expect(route("/portal/tasks/later")).toEqual({ view: "tasks", taskView: "today" });
  });
});
