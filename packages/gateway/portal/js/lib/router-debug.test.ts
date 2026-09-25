// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Every internal-state surface of the gateway is a tab of the Debug page.
// These assert the four things routing must get right for that: each tab is
// addressable, the tabs that carry state parse it out of the query string,
// the alternate paths some tabs answer to resolve, and any path that isn't
// the canonical spelling of the tab on screen redirects to one that is.

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { parseRoute } from "./router.js";

function route(pathname: string, search = "") {
  vi.stubGlobal("location", { pathname, search });
  return parseRoute();
}

afterEach(() => vi.unstubAllGlobals());

describe("Debug page tabs", () => {
  test("the bare path opens the default tab, with or without a trailing slash", () => {
    const expected = { view: "debug", tab: "data", data: { store: null, table: null } };
    expect(route("/portal/debug")).toEqual(expected);
    expect(route("/portal/debug/")).toEqual(expected);
  });

  test("every tab is addressable by its own path segment", () => {
    expect(route("/portal/debug/metrics")).toEqual({ view: "debug", tab: "metrics" });
    expect(route("/portal/debug/background-jobs")).toEqual({
      view: "debug",
      tab: "background-jobs",
    });
    expect(route("/portal/debug/doctor")).toEqual({ view: "debug", tab: "doctor" });
  });

  test("the Data tab carries the selected table in the query string", () => {
    expect(route("/portal/debug/data", "?store=duckdb&table=strava_activities")).toEqual({
      view: "debug",
      tab: "data",
      data: { store: "duckdb", table: "strava_activities" },
    });
  });

  test("the SQL tab carries the store and a pre-filled statement", () => {
    expect(
      route("/portal/debug/sql", "?store=duckdb&sql=SELECT%201"),
    ).toEqual({
      view: "debug",
      tab: "sql",
      sql: { store: "duckdb", sql: "SELECT 1" },
    });
  });

  test("an absent query string leaves the state-carrying tabs at their defaults", () => {
    expect(route("/portal/debug/sql")).toEqual({
      view: "debug",
      tab: "sql",
      sql: { store: null, sql: null },
    });
  });

  test("the Graph tab still parses its seed and render options", () => {
    const parsed = route("/portal/debug/graph", "?documentId=doc-1&depth=3&collapse=0");
    expect(parsed).toMatchObject({
      view: "debug",
      tab: "graph",
      graph: { documentId: "doc-1", depth: 3, collapse: false, showMentions: true },
    });
  });
});

describe("Alternate paths for a Debug tab", () => {
  test("resolve to their tab and redirect to the canonical path", () => {
    expect(route("/portal/data")).toMatchObject({
      view: "debug",
      tab: "data",
      redirectTo: "/portal/debug/data",
    });
    expect(route("/portal/sql")).toMatchObject({
      view: "debug",
      tab: "sql",
      redirectTo: "/portal/debug/sql",
    });
    expect(route("/portal/graph")).toMatchObject({
      view: "debug",
      tab: "graph",
      redirectTo: "/portal/debug/graph",
    });
  });

  test("a trailing slash resolves the same way", () => {
    expect(route("/portal/sql/")).toMatchObject({ view: "debug", tab: "sql" });
    expect(route("/portal/data/")).toMatchObject({ view: "debug", tab: "data" });
  });

  test("the redirect preserves the query string, so a deep link keeps its state", () => {
    expect(route("/portal/data", "?store=sqlite&table=documents")).toMatchObject({
      redirectTo: "/portal/debug/data?store=sqlite&table=documents",
      data: { store: "sqlite", table: "documents" },
    });
  });

  test("a canonical path carries no redirect — nothing to rewrite", () => {
    expect(route("/portal/debug/sql")).not.toHaveProperty("redirectTo");
    expect(route("/portal/debug")).not.toHaveProperty("redirectTo");
    // The default tab answers to both spellings; neither is rewritten.
    expect(route("/portal/debug/data")).not.toHaveProperty("redirectTo");
  });
});

describe("A tab segment the page cannot show", () => {
  test("falls back to the default tab and redirects, so the URL never lies", () => {
    expect(route("/portal/debug/nonexistent")).toMatchObject({
      view: "debug",
      tab: "data",
      redirectTo: "/portal/debug/data",
    });
  });

  test("the fallback keeps the query string rather than discarding it", () => {
    expect(route("/portal/debug/nope", "?store=sqlite&table=documents")).toMatchObject({
      tab: "data",
      redirectTo: "/portal/debug/data?store=sqlite&table=documents",
    });
  });
});

describe("The tab set the router validates against", () => {
  test("is the one the view renders — a reorder or rename cannot desync them", async () => {
    // @ts-expect-error — portal is plain JS without sibling declarations.
    const { DEBUG_TAB_KEYS, DEFAULT_DEBUG_TAB, debugTabs } = await import("./debug-tabs.js");

    // Every renderable tab is addressable, in both experimental modes.
    for (const t of debugTabs(true)) {
      expect(DEBUG_TAB_KEYS).toContain(t.key);
      expect(route(`/portal/debug/${t.key}`).tab).toBe(t.key);
    }
    // The bare path opens the first tab the view draws.
    expect(DEFAULT_DEBUG_TAB).toBe(debugTabs(false)[0].key);
    expect(route("/portal/debug").tab).toBe(debugTabs(false)[0].key);
  });
});

describe("Watch sub-routes", () => {
  test("resolve ahead of the single-segment tab matcher", () => {
    expect(route("/portal/debug/watch")).toEqual({
      view: "debug",
      tab: "watch",
      watchDebugId: null,
      watchDebugSeq: null,
    });
    expect(route("/portal/debug/watch/")).toEqual({
      view: "debug",
      tab: "watch",
      watchDebugId: null,
      watchDebugSeq: null,
    });
  });

  test("carry the watch id, decoded — an id is opaque and need not be path-safe", () => {
    expect(route("/portal/debug/watch/watch-01")).toEqual({
      view: "debug",
      tab: "watch",
      watchDebugId: "watch-01",
      watchDebugSeq: null,
    });
    expect(route("/portal/debug/watch/a%2Fb")).toMatchObject({ watchDebugId: "a/b" });
  });

  test("carry the journal event a firing links to, negatives and all", () => {
    // A deep link from the Watches ledger addresses the moment a firing
    // happened, and the runtime journals its own timers with sequences
    // counting down from -1 — so a deadline's event is a negative number.
    expect(route("/portal/debug/watch/watch-01/history/412")).toMatchObject({
      tab: "watch",
      watchDebugId: "watch-01",
      watchDebugSeq: 412,
    });
    expect(route("/portal/debug/watch/watch-01/history/-3")).toMatchObject({
      watchDebugId: "watch-01",
      watchDebugSeq: -3,
    });
    // Not a sequence number: the whole path stops being a watch route rather
    // than opening a canvas with a selection nothing can resolve.
    expect(route("/portal/debug/watch/watch-01/history/nope").tab).not.toBe("watch");
    // A link that lost its event still opens the watch, rather than falling
    // past every Debug matcher to the search view.
    for (const path of [
      "/portal/debug/watch/watch-01/history",
      "/portal/debug/watch/watch-01/history/",
    ]) {
      expect(route(path), path).toMatchObject({
        tab: "watch",
        watchDebugId: "watch-01",
        watchDebugSeq: null,
      });
    }
  });

  test("an undecodable id opens the list rather than asking for a watch by nonsense", () => {
    expect(route("/portal/debug/watch/%E0%A4%A")).toMatchObject({
      tab: "watch",
      watchDebugId: null,
    });
  });
});

describe("Cognition sub-routes", () => {
  test("resolve ahead of the single-segment tab matcher", () => {
    expect(route("/portal/debug/cognition")).toEqual({
      view: "debug",
      tab: "cognition",
      cognitionTab: "overview",
      cognitionId: null,
    });
    expect(route("/portal/debug/cognition/runs/run-42")).toEqual({
      view: "debug",
      tab: "cognition",
      cognitionTab: "runs",
      cognitionId: "run-42",
    });
  });
});
