// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// In-app navigation honors editors with unsaved work: a set guard can
// allow the navigation silently (null), allow it after a native confirm
// (message + confirmed), or abort it (message + declined) before history
// is touched.

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { navigate, replaceRoute, replaceUrl, onRouteChange, setRouteLeaveGuard } from "./router.js";

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

test("a pending-request verdict blocks in-app navigation without offering discard", () => {
  const browser = stubBrowser();
  setRouteLeaveGuard(() => false);
  expect(navigate("/portal/search")).toBe(false);
  expect(replaceRoute("/portal/settings/models")).toBe(false);
  expect(browser.pushState).not.toHaveBeenCalled();
  expect(browser.replaceState).not.toHaveBeenCalled();
  expect(window.confirm).not.toHaveBeenCalled();
});

test("declined Back and Forward restore the accepted entry without changing its state or forward history", () => {
  const target = new EventTarget();
  const location = { href: "https://example.com/portal/settings/access" };
  const browser = Object.assign(target, { location, confirm: vi.fn(() => false) });
  const entries: Array<{ state: Record<string, unknown>; url: string }> = [
    { state: { retained: "initial" }, url: location.href },
  ];
  let index = 0;
  const history = {
    state: entries[0]!.state,
    pushState: vi.fn((state, _unused, path) => {
      index++;
      entries.splice(index);
      entries.push({ state, url: new URL(path, location.href).href });
      history.state = state;
      location.href = entries[index]!.url;
    }),
    replaceState: vi.fn((state, _unused, path) => {
      entries[index] = { state, url: new URL(path, location.href).href };
      history.state = state;
      location.href = entries[index]!.url;
    }),
    go: vi.fn((delta: number) => {
      index += delta;
      history.state = entries[index]!.state;
      location.href = entries[index]!.url;
    }),
  };
  vi.stubGlobal("window", browser);
  vi.stubGlobal("history", history);
  const changed = vi.fn();
  const stop = onRouteChange(changed);
  navigate("/portal/settings/access/levels/new");
  replaceUrl("/portal/settings/access/levels/new?draft=retained#selection");
  history.replaceState({ ...history.state, retained: "draft" }, "", location.href);
  const savedState = history.state;
  navigate("/portal/settings/access");
  const lastState = history.state;
  setRouteLeaveGuard(() => "Discard unsaved draft?");
  const pop = () => browser.dispatchEvent(new Event("popstate"));
  history.go(-1);
  pop();
  expect(history.go).toHaveBeenLastCalledWith(1);
  expect(history.state).toBe(lastState);
  pop();
  expect(changed).toHaveBeenCalledTimes(2);
  browser.confirm.mockReturnValue(true);
  history.go(-1);
  pop();
  expect(history.state).toBe(savedState);
  expect(history.state.retained).toBe("draft");
  browser.confirm.mockReturnValue(false);
  history.go(1);
  pop();
  expect(history.go).toHaveBeenLastCalledWith(-1);
  expect(history.state).toBe(savedState);
  pop();
  expect(changed).toHaveBeenCalledTimes(3);
  browser.confirm.mockReturnValue(true);
  history.go(1);
  pop();
  expect(history.state).toBe(lastState);
  expect(entries).toHaveLength(3);
  expect(changed).toHaveBeenCalledTimes(4);
  stop();
});

test("a save completing during history recovery navigates after restoration rather than overwriting the traversed entry", () => {
  const target = new EventTarget();
  const location = { href: "https://example.com/portal/settings/access" };
  const browser = Object.assign(target, { location, confirm: vi.fn(() => false) });
  const history = {
    state: {} as Record<string, unknown>,
    pushState: vi.fn((state, _unused, path) => {
      history.state = state;
      location.href = new URL(path, location.href).href;
    }),
    replaceState: vi.fn((state, _unused, path) => {
      history.state = state;
      location.href = new URL(path, location.href).href;
    }),
    go: vi.fn(),
  };
  vi.stubGlobal("window", browser);
  vi.stubGlobal("history", history);
  const changed = vi.fn();
  const stop = onRouteChange(changed);
  const initialState = history.state;
  navigate("/portal/settings/access/levels/new");
  const draftState = history.state,
    draftUrl = location.href;
  setRouteLeaveGuard(() => false);
  history.state = initialState;
  location.href = "https://example.com/portal/settings/access";
  browser.dispatchEvent(new Event("popstate"));
  expect(history.go).toHaveBeenCalledWith(1);
  setRouteLeaveGuard(null);
  expect(replaceRoute("/portal/settings/access?saved=1")).toBe(false);
  expect(history.state).toBe(initialState);
  history.state = draftState;
  location.href = draftUrl;
  browser.dispatchEvent(new Event("popstate"));
  expect(location.href).toBe("https://example.com/portal/settings/access?saved=1");
  expect(changed).toHaveBeenCalledTimes(2);
  stop();
});
