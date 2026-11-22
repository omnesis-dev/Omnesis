// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The one window an Omnesis account connection runs in: the security check, then the account's
// sign-in. The portal opens it from the person's click and keeps its handle, so once the gateway
// reports that the check passed it sends the same window on to the sign-in.
//
// The security check and the sign-in are other parties' pages, and a page whose window has an
// opener can navigate that opener's tab somewhere else. So the window never shows them with an
// opener: it opens on `CONNECT_PAGE`, a page of this portal's own origin, where the portal cuts it
// off (`opener = null`) and then sends it on. Cut off, the window may only be navigated by a page
// of the same origin as the one it shows, so the portal moves it only while it is back on
// `CONNECT_PAGE`: the security check's page goes back there once the check passes (it is told
// to by `OPENED_BY_PORTAL`), and the portal sends it on to the sign-in from there. Nor can the
// portal close the window while it shows another origin's page, so a window that ends on the
// account's page stays there, which tells the person they can close it.
//
// A browser that refuses the window gives null, or a window already closed: the caller then lets
// the link open its page as an ordinary new tab, which shows its own way back.

import { useEffect, useRef } from "preact/hooks";
import { relayHttpsUrl } from "./cloud-relay-api.js";

/** The window's name, so a second click reuses it instead of opening another. */
export const CONNECT_WINDOW_NAME = "omnesis-connect";

/** The portal's own page the window opens on and comes back to between the other pages. */
export const CONNECT_PAGE = "/portal/connect-window.html";

/**
 * Added to the security check's address when it opens in this window: once the check passes,
 * its page goes back to `CONNECT_PAGE` and says the window goes on by itself.
 */
export const OPENED_BY_PORTAL = "#opened-by-portal";

/** How often the portal looks whether the window is back on its own page, while it has somewhere to send it. */
const SEND_INTERVAL_MS = 250;

let current = null;
let pending = null;
let timer = null;

/** The window, while it is open; a window the person closed is forgotten with what was waiting for it. */
function live() {
  if (current && !current.closed) return current;
  current = null;
  pending = null;
  clearInterval(timer);
  timer = null;
  return null;
}

/** Whether the window shows `CONNECT_PAGE`, fully loaded: the one time the portal may move it. */
function onConnectPage(win) {
  try {
    return win.location.pathname === CONNECT_PAGE && win.document.readyState === "complete";
  } catch {
    // Another origin's page: neither readable nor movable from here.
    return false;
  }
}

/** Sends the window to the address waiting for it, once it is back on the portal's page. */
function send() {
  const win = live();
  if (!win || !onConnectPage(win)) return;
  win.location.href = pending;
  pending = null;
  clearInterval(timer);
  timer = null;
}

function sendWhenBack(url) {
  pending = url;
  send();
  if (pending && !timer) timer = setInterval(send, SEND_INTERVAL_MS);
}

/**
 * Opens `url` in the connect window, from a click. Returns whether it did; when not, the
 * caller's link opens it the ordinary way.
 */
export function openConnectWindow(url, win = globalThis.window) {
  const open = live();
  if (open) {
    open.focus?.();
    sendWhenBack(url);
    return true;
  }
  let opened = null;
  try {
    opened = win.open(CONNECT_PAGE, CONNECT_WINDOW_NAME);
  } catch {
    opened = null;
  }
  if (!opened || opened.closed) return false;
  try {
    opened.opener = null;
  } catch {
    // A window of that name on another origin was cut off when it was first opened.
  }
  current = opened;
  sendWhenBack(url);
  return true;
}

/** Sends the connect window on to `url` once it is back on the portal's page; nothing without one. */
export function followConnectWindow(url) {
  if (live()) sendWhenBack(url);
}

/**
 * Lets the connect window go, closing it while it still shows the portal's page; on another
 * origin's page only that page can close it.
 */
export function closeConnectWindow() {
  const win = live();
  if (win && onConnectPage(win)) win.close();
  current = null;
  live();
}

/**
 * Keeps the connect window in step with the connection: on to the sign-in once the security
 * check has passed, and let go once this page saw connecting stop waiting for the person. A page
 * that has not seen it waiting (its status still loading, say) never lets go of the window.
 */
export function useConnectWindow(connect) {
  const waiting = connect?.state === "waiting";
  const signIn = waiting && !connect.verification ? relayHttpsUrl(connect.authorizeUrl) : null;
  const wasWaiting = useRef(false);
  useEffect(() => {
    if (signIn) followConnectWindow(signIn);
  }, [signIn]);
  useEffect(() => {
    if (waiting) wasWaiting.current = true;
    else if (wasWaiting.current) {
      wasWaiting.current = false;
      closeConnectWindow();
    }
  }, [waiting]);
}
