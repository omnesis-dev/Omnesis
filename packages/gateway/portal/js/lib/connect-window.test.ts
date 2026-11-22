// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  CONNECT_PAGE,
  CONNECT_WINDOW_NAME,
  closeConnectWindow,
  followConnectWindow,
  inConnectWindow,
  openConnectWindow,
  useConnectWindow,
  // @ts-expect-error portal JS
} from "./connect-window.js";

const CHECK = "https://dns.example.test/_dns/v2/enroll?ticket=fictional#opened-by-portal";
const SIGN_IN = "https://relay.example.test/_relay/v3/signup/begin?ticket=fictional";

/**
 * A window as `window.open` hands it back, loading the portal's own page. Once sent to another
 * origin's page it can no longer be read, as in a browser; `back()` returns it to the portal's page.
 */
function popup() {
  const state = { foreign: false, path: CONNECT_PAGE, ready: "loading", sent: [] as string[] };
  const guard = () => {
    if (state.foreign) throw new Error("Blocked a frame from accessing a cross-origin frame.");
  };
  const win = {
    closed: false,
    opener: {} as unknown,
    location: {
      get pathname() {
        guard();
        return state.path;
      },
      set href(url: string) {
        state.sent.push(url);
        state.foreign = true;
      },
    },
    document: {
      get readyState() {
        guard();
        return state.ready;
      },
    },
    close: vi.fn(() => {
      win.closed = true;
    }),
    focus: vi.fn(),
  };
  return {
    win,
    sent: state.sent,
    loaded: () => {
      state.ready = "complete";
    },
    back: () => {
      Object.assign(state, { foreign: false, path: CONNECT_PAGE, ready: "complete" });
    },
  };
}
function opener(result: unknown) {
  return { open: vi.fn(() => result) };
}

let host: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", dom.document);
  host = dom.document.querySelector("main") as unknown as HTMLElement;
});
afterEach(() => {
  render(null, host);
  closeConnectWindow();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("opens on the portal's own page, cuts it off from the portal, then sends it on once loaded", () => {
  const p = popup();
  const win = opener(p.win);
  expect(openConnectWindow(CHECK, win)).toBe(true);
  expect(win.open).toHaveBeenCalledExactlyOnceWith(CONNECT_PAGE, CONNECT_WINDOW_NAME);
  expect(p.win.opener).toBeNull();
  // Sent on only once that page has finished loading, so it stays in the window's history.
  vi.advanceTimersByTime(1000);
  expect(p.sent).toEqual([]);
  p.loaded();
  vi.advanceTimersByTime(250);
  expect(p.sent).toEqual([CHECK]);
  vi.advanceTimersByTime(1000);
  expect(p.sent).toEqual([CHECK]);
});

test("moves the window on to the sign-in only once it is back on the portal's page", () => {
  const p = popup();
  p.loaded();
  openConnectWindow(CHECK, opener(p.win));
  expect(p.sent).toEqual([CHECK]);
  // Still on the check's page: another origin, which the portal can neither read nor move.
  followConnectWindow(SIGN_IN);
  vi.advanceTimersByTime(5000);
  expect(p.sent).toEqual([CHECK]);
  // The check passed and its page went back.
  p.back();
  vi.advanceTimersByTime(250);
  expect(p.sent).toEqual([CHECK, SIGN_IN]);
  // A second click reuses the window and brings it forward.
  p.back();
  const win = opener(null);
  expect(openConnectWindow(SIGN_IN, win)).toBe(true);
  expect(win.open).not.toHaveBeenCalled();
  expect(p.win.focus).toHaveBeenCalledOnce();
  expect(p.sent).toEqual([CHECK, SIGN_IN, SIGN_IN]);
});

test("a refused window is reported, so the link opens its page the ordinary way", () => {
  expect(openConnectWindow(CHECK, opener(null))).toBe(false);
  expect(openConnectWindow(CHECK, opener({ ...popup().win, closed: true }))).toBe(false);
  const throwing = {
    open: vi.fn(() => {
      throw new Error("blocked");
    }),
  };
  expect(openConnectWindow(CHECK, throwing)).toBe(false);
  // Nothing is kept, so nothing is followed or closed afterwards.
  followConnectWindow(SIGN_IN);
  closeConnectWindow();
});

test("a window whose opener can't be changed any more is still sent on", () => {
  const p = popup();
  p.loaded();
  Object.defineProperty(p.win, "opener", {
    set() {
      throw new Error("cross-origin");
    },
  });
  expect(openConnectWindow(CHECK, opener(p.win))).toBe(true);
  expect(p.sent).toEqual([CHECK]);
});

test("closes the window only while it shows the portal's page, and forgets one the person closed", () => {
  const p = popup();
  openConnectWindow(CHECK, opener(p.win));
  p.loaded();
  vi.advanceTimersByTime(250);
  // On another origin's page only that page can close it: the portal lets it go.
  closeConnectWindow();
  expect(p.win.close).not.toHaveBeenCalled();
  p.back();
  followConnectWindow(SIGN_IN);
  vi.advanceTimersByTime(1000);
  expect(p.sent).toEqual([CHECK]);
  // Back on the portal's page, it closes.
  const q = popup();
  q.loaded();
  openConnectWindow(CHECK, opener(q.win));
  q.back();
  closeConnectWindow();
  expect(q.win.close).toHaveBeenCalledOnce();
  // Closed by the person while waiting to be sent on: nothing waits for it any more.
  const r = popup();
  openConnectWindow(CHECK, opener(r.win));
  r.win.closed = true;
  r.loaded();
  vi.advanceTimersByTime(1000);
  expect(r.sent).toEqual([]);
  const s = popup();
  const fresh = opener(s.win);
  expect(openConnectWindow(SIGN_IN, fresh)).toBe(true);
  expect(fresh.open).toHaveBeenCalledOnce();
});

function Probe({ connect }: { connect?: Record<string, unknown> }) {
  useConnectWindow(connect);
  return null;
}
async function show(connect?: Record<string, unknown>) {
  await act(async () => render(h(Probe, { connect }), host));
}

test("sends the window on to the sign-in once the check passed, and lets it go once connecting moves on", async () => {
  const p = popup();
  p.loaded();
  await show({ state: "waiting", verification: { url: CHECK, expiresAt: 1 } });
  openConnectWindow(CHECK, opener(p.win));
  p.back();
  await show({ state: "waiting", verification: { url: CHECK, expiresAt: 1 } });
  vi.advanceTimersByTime(1000);
  expect(p.sent).toEqual([CHECK]);
  // A sign-in address that is not plain HTTPS is never followed.
  await show({ state: "waiting", authorizeUrl: "javascript:alert(1)" });
  vi.advanceTimersByTime(1000);
  expect(p.sent).toEqual([CHECK]);
  await show({ state: "waiting", authorizeUrl: SIGN_IN });
  vi.advanceTimersByTime(250);
  // Marked as this window's, so the page the sign-in ends on closes it.
  expect(p.sent).toEqual([CHECK, `${SIGN_IN}&window=portal`]);
  p.back();
  await show({ state: "registering" });
  expect(p.win.close).toHaveBeenCalledOnce();
});

test("a page that never saw the connection waiting leaves the window alone", async () => {
  const p = popup();
  p.loaded();
  openConnectWindow(CHECK, opener(p.win));
  p.back();
  // Still loading its status, then a connection already over: not this page's window to close.
  await show(undefined);
  await show({ state: "done" });
  expect(p.win.close).not.toHaveBeenCalled();
});

test("the sign-in link the window opens says so in one field, and keeps everything else", () => {
  expect(inConnectWindow(SIGN_IN)).toBe(`${SIGN_IN}&window=portal`);
  // Set once, however often it is marked.
  expect(inConnectWindow(inConnectWindow(SIGN_IN))).toBe(`${SIGN_IN}&window=portal`);
});
