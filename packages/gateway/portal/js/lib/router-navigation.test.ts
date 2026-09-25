// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// In-app navigation honors editors with unsaved work: a set guard can
// allow the navigation silently (null), allow it after a native confirm
// (message + confirmed), or abort it (message + declined) before history
// is touched.

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { navigate, replaceRoute, setRouteLeaveGuard } from "./router.js";

function stubBrowser(confirmImpl?: (message: string) => boolean) {
  const pushState = vi.fn();
  const replaceState = vi.fn();
  const dispatchEvent = vi.fn();
  vi.stubGlobal("history", { pushState, replaceState });
  vi.stubGlobal("window", {
    dispatchEvent,
    confirm: confirmImpl ? vi.fn(confirmImpl) : vi.fn(() => true),
  });
  return { pushState, replaceState, dispatchEvent };
}

afterEach(() => {
  setRouteLeaveGuard(null);
  vi.unstubAllGlobals();
});

describe("route leave guard", () => {
  test("navigations proceed and return true with no guard set", () => {
    const browser = stubBrowser();
    expect(navigate("/portal/search")).toBe(true);
    expect(replaceRoute("/portal/settings/config")).toBe(true);
    expect(browser.pushState).toHaveBeenCalledTimes(1);
    expect(browser.replaceState).toHaveBeenCalledTimes(1);
    expect(browser.dispatchEvent).toHaveBeenCalledTimes(2);
  });

  test("a null verdict navigates without prompting", () => {
    const browser = stubBrowser();
    setRouteLeaveGuard(() => null);
    expect(navigate("/portal/search")).toBe(true);
    expect(browser.pushState).toHaveBeenCalledTimes(1);
  });

  test("a confirmed message navigates", () => {
    const browser = stubBrowser(() => true);
    setRouteLeaveGuard(() => "You have unsaved config changes. Leave without saving?");
    expect(replaceRoute("/portal/settings/models")).toBe(true);
    expect(browser.replaceState).toHaveBeenCalledTimes(1);
  });

  test("a declined message aborts before touching history", () => {
    const browser = stubBrowser(() => false);
    setRouteLeaveGuard(() => "You have unsaved config changes. Leave without saving?");
    expect(navigate("/portal/search")).toBe(false);
    expect(replaceRoute("/portal/settings/models")).toBe(false);
    expect(browser.pushState).not.toHaveBeenCalled();
    expect(browser.replaceState).not.toHaveBeenCalled();
    expect(browser.dispatchEvent).not.toHaveBeenCalled();
  });
});
