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

describe("Portal default route", () => {
  test("opens a new Agent conversation with or without a trailing slash", () => {
    expect(route("/portal")).toEqual({ view: "agent", convoId: null });
    expect(route("/portal/")).toEqual({ view: "agent", convoId: null });
  });
});

describe("Privacy portal routes", () => {
  const dashboard = {
    view: "privacy",
    approvalId: null,
    conversationId: null,
    taskId: null,
    directTab: false,
    directSessionId: null,
  };

  test("parses the Privacy dashboard with or without a trailing slash", () => {
    expect(route("/portal/audit")).toEqual(dashboard);
    expect(route("/portal/audit/")).toEqual(dashboard);
    expect(route("/portal/audit").redirectTo).toBeUndefined();
  });

  test("the folded-away activity routes resolve into the section that absorbed them", () => {
    expect(route("/portal/audit/activity")).toEqual({
      ...dashboard,
      redirectTo: "/portal/audit",
    });
    expect(route("/portal/audit/conversations")).toEqual({
      ...dashboard,
      redirectTo: "/portal/audit",
    });
    expect(route("/portal/audit/approvals")).toEqual({
      ...dashboard,
      redirectTo: "/portal/audit",
    });
  });

  test("the policy path resolves to the Policies tab, where the policies are edited", () => {
    expect(route("/portal/audit/policy")).toEqual({
      view: "settings",
      tab: "policies",
      modelsSection: null,
      redirectTo: "/portal/settings/policies",
    });
  });

  test("decodes an opaque approval id without swallowing extra path segments", () => {
    expect(route("/portal/audit/approvals/approval%2Fexample")).toEqual({
      ...dashboard,
      approvalId: "approval/example",
    });
    expect(route("/portal/audit/approvals/id/extra").view).not.toBe("privacy");
  });

  test("the Direct tab and one open session are addressable", () => {
    expect(route("/portal/audit/direct")).toEqual({
      ...dashboard,
      directTab: true,
      directSessionId: null,
    });
    expect(route("/portal/audit/direct/")).toEqual({
      ...dashboard,
      directTab: true,
      directSessionId: null,
    });
    expect(route("/portal/audit/direct/direct_session-1")).toEqual({
      ...dashboard,
      directTab: true,
      directSessionId: "direct_session-1",
    });
    expect(route("/portal/audit/direct/id/extra").view).not.toBe("privacy");
  });

  test("decodes opaque conversation ids without accepting extra segments", () => {
    expect(route("/portal/audit/conversations/conversation%2Fexample")).toEqual({
      ...dashboard,
      conversationId: "conversation/example",
    });
    expect(route("/portal/audit/conversations/id/extra").view).not.toBe("privacy");
  });

  test("one exchange is addressed by the task it opened", () => {
    expect(
      route("/portal/audit/conversations/conversation%2Fexample/exchanges/task%2Fexample"),
    ).toEqual({
      ...dashboard,
      conversationId: "conversation/example",
      taskId: "task/example",
    });
    expect(route("/portal/audit/conversations/id/exchanges/one/two").view).not.toBe("privacy");
    expect(route("/portal/audit/conversations/id/exchanges/%").view).toBe("search");
  });

  test("the retired audit path opens the conversation it names", () => {
    expect(route("/portal/audit/conversations/conversation%2Fexample/audit")).toEqual({
      ...dashboard,
      conversationId: "conversation/example",
      redirectTo: "/portal/audit/conversations/conversation%2Fexample",
    });
  });

  test("fails closed for unknown privacy paths and malformed opaque ids", () => {
    expect(route("/portal/audit/garbage").view).toBe("search");
    expect(route("/portal/audit/conversations/%E0%A4%A").view).toBe("search");
    expect(route("/portal/audit/approvals/%").view).toBe("search");
  });
});

describe("Watches portal routes", () => {
  test("routes the inbox, one watch, and one watch request", () => {
    expect(route("/portal/watches")).toEqual({
      view: "watches",
      watchApprovalId: null,
      watchId: null,
      watchFiringId: null,
    });
    expect(route("/portal/watches/")).toEqual({
      view: "watches",
      watchApprovalId: null,
      watchId: null,
      watchFiringId: null,
    });
    expect(route("/portal/watches/watch%2Fexample")).toEqual({
      view: "watches",
      watchApprovalId: null,
      watchId: "watch/example",
      watchFiringId: null,
    });
    expect(route("/portal/watches/approvals/approval%2Fexample")).toEqual({
      view: "watches",
      watchApprovalId: "approval/example",
      watchId: null,
      watchFiringId: null,
    });
  });

  test("the bare approvals path is the inbox, not a watch called approvals", () => {
    expect(route("/portal/watches/approvals")).toEqual({
      view: "watches",
      watchApprovalId: null,
      watchId: null,
      watchFiringId: null,
    });
  });

  test("routes one firing's detail without swallowing it into the watch id", () => {
    expect(route("/portal/watches/watch%2Fexample/firings/firing%2Fexample")).toEqual({
      view: "watches",
      watchApprovalId: null,
      watchId: "watch/example",
      watchFiringId: "firing/example",
    });
  });

  test("the retired privacy paths resolve to the same page and say where it moved", () => {
    expect(route("/portal/audit/subscriptions/watch%2Fexample")).toEqual({
      view: "watches",
      watchApprovalId: null,
      watchId: "watch/example",
      watchFiringId: null,
      redirectTo: "/portal/watches/watch%2Fexample",
    });
    expect(route("/portal/audit/subscription-approvals/approval%2Fexample")).toEqual({
      view: "watches",
      watchApprovalId: "approval/example",
      watchId: null,
      watchFiringId: null,
      redirectTo: "/portal/watches/approvals/approval%2Fexample",
    });
    expect(route("/portal/audit/subscriptions")).toEqual({
      view: "watches",
      watchApprovalId: null,
      watchId: null,
      watchFiringId: null,
      redirectTo: "/portal/watches",
    });
    expect(
      route("/portal/audit/subscriptions/watch%2Fexample/firings/firing%2Fexample"),
    ).toEqual({
      view: "watches",
      watchApprovalId: null,
      watchId: "watch/example",
      watchFiringId: "firing/example",
      redirectTo: "/portal/watches/watch%2Fexample/firings/firing%2Fexample",
    });
  });

  test("a canonical watch path carries no redirect", () => {
    expect(route("/portal/watches/watch%2Fexample").redirectTo).toBeUndefined();
    expect(route("/portal/watches").redirectTo).toBeUndefined();
  });

  test("fails closed for malformed opaque ids and extra segments", () => {
    expect(route("/portal/watches/%").view).toBe("search");
    expect(route("/portal/watches/approvals/%").view).toBe("search");
    expect(route("/portal/watches/id/extra").view).not.toBe("watches");
    expect(route("/portal/audit/subscriptions/id/extra").view).not.toBe("watches");
    expect(route("/portal/watches/id/firings/%").view).toBe("search");
    expect(route("/portal/watches/id/firings/one/two").view).not.toBe("watches");
  });
});
