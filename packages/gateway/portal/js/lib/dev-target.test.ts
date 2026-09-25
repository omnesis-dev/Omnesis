// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
// @ts-expect-error — sibling .js module, no .d.ts in the portal tree.
import { deriveDevTarget } from "./dev-target.js";

describe("deriveDevTarget", () => {
  test("maps a document route to a document target", () => {
    expect(deriveDevTarget({ view: "document", id: "doc-1" }, "/portal/doc/doc-1")).toEqual({
      targetType: "document",
      targetId: "doc-1",
      label: "Document doc-1",
      deepLink: "/portal/doc/doc-1",
    });
  });

  test("maps an agent conversation to a conversation target", () => {
    expect(deriveDevTarget({ view: "agent", convoId: "c-9" }, "/portal/agent/c-9")).toMatchObject({
      targetType: "conversation",
      targetId: "c-9",
    });
  });

  test("falls back to activeConvoId when the agent route id is null (resumed past convo)", () => {
    // A resumed conversation rewrites the URL silently, so route.convoId is
    // null even though a conversation is open; the app's activeConvoId wins.
    expect(
      deriveDevTarget({ view: "agent", convoId: null }, "/portal/agent/s_past", "s_past"),
    ).toMatchObject({ targetType: "conversation", targetId: "s_past" });
    // With neither, it's a free-form route note.
    expect(deriveDevTarget({ view: "agent", convoId: null }, "/portal/agent").targetType).toBe(
      "route",
    );
  });

  test("maps cognition sub-entities to their target types", () => {
    const cases: Array<[string, string]> = [
      ["loops", "open_loop"],
      ["runs", "agent_run"],
      ["briefs", "brief"],
      ["temporal-annotations", "temporal_annotation"],
      ["time-index", "temporal_annotation"],
    ];
    for (const [tab, type] of cases) {
      expect(
        deriveDevTarget(
          { view: "debug", tab: "cognition", cognitionTab: tab, cognitionId: "x-1" },
          `/portal/debug/cognition/${tab}/x-1`,
        ),
      ).toMatchObject({ targetType: type, targetId: "x-1" });
    }
  });

  test("falls back to a free-form route note when no entity is in focus", () => {
    expect(deriveDevTarget({ view: "people", tab: "list" }, "/portal/people")).toEqual({
      targetType: "route",
      targetId: null,
      label: "General note — /portal/people",
      deepLink: "/portal/people",
    });
  });

  test("does not infer a Calendar item's origin from its id", () => {
    expect(
      deriveDevTarget(
        { view: "debug", tab: "cognition", cognitionTab: "calendar", cognitionId: "tp_1" },
        "/portal/debug/cognition/calendar/tp_1",
      ),
    ).toMatchObject({ targetType: "route", targetId: null });
  });

  test("agent index (no conversation) and cognition overview fall back to route", () => {
    expect(deriveDevTarget({ view: "agent", convoId: null }, "/portal/agent").targetType).toBe(
      "route",
    );
    expect(
      deriveDevTarget(
        { view: "debug", tab: "cognition", cognitionTab: "overview", cognitionId: null },
        "/portal/debug/cognition",
      ).targetType,
    ).toBe("route");
  });
});
