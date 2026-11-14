// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Optional unsaved-work guard for editors. The guard returns a message when
// navigating now would discard edits, false while a request must settle, or
// null to allow it. Both in-app
// navigations run it; a declined guard aborts before touching history.
// A native dialog is deliberate: navigation is synchronous, so an async
// modal promise cannot gate it. Last setter wins; editors clear on unmount.
let routeLeaveGuard = null;
const HISTORY_INDEX = "__omnesisRouteIndex";
let historyIndex = 0;
let historyRestoring = false;
let pendingRoute = null;
const routeState = () => ({ ...(history.state ?? {}), [HISTORY_INDEX]: historyIndex });
export function setRouteLeaveGuard(guard) {
  routeLeaveGuard = guard;
}
function allowRouteLeave() {
  if (typeof routeLeaveGuard !== "function") return true;
  const message = routeLeaveGuard();
  return message === false ? false : !message || window.confirm(message);
}

export function navigate(path) {
  if (historyRestoring) {
    pendingRoute = { kind: "push", path };
    return false;
  }
  if (!allowRouteLeave()) return false;
  historyIndex++;
  history.pushState({ [HISTORY_INDEX]: historyIndex }, "", path);
  window.dispatchEvent(new CustomEvent("route-change"));
  return true;
}

// Replace the current history entry and re-render from the new route. Use this
// when the old URL represents state the user explicitly cleared: Browser Back
// must not resurrect it.
export function replaceRoute(path) {
  if (historyRestoring) {
    pendingRoute = { kind: "replace", path };
    return false;
  }
  if (!allowRouteLeave()) return false;
  history.replaceState(routeState(), "", path);
  window.dispatchEvent(new CustomEvent("route-change"));
  return true;
}

// Replace the current history entry without pushing a new one. Used when
// the URL needs to mirror in-page state (e.g. the People search box's
// `?q=` query) — pushState here would flood the back stack with one
// entry per keystroke. No route-change event is fired since the in-page
// state already changed and components don't need to re-derive from URL.
export function replaceUrl(path) {
  if (historyRestoring) {
    pendingRoute = { kind: "url", path };
    return;
  }
  history.replaceState(routeState(), "", path);
}

export function onRouteChange(callback) {
  historyRestoring = false;
  pendingRoute = null;
  historyIndex = Number.isSafeInteger(history.state?.[HISTORY_INDEX])
    ? history.state[HISTORY_INDEX]
    : 0;
  history.replaceState(routeState(), "", window.location.href);
  let acceptedIndex = historyIndex;
  let acceptedUrl = window.location.href;
  let acceptedState = history.state;
  const changed = () => {
    historyIndex = history.state?.[HISTORY_INDEX] ?? historyIndex;
    acceptedIndex = historyIndex;
    acceptedUrl = window.location.href;
    acceptedState = history.state;
    callback();
  };
  const traversed = () => {
    const target = history.state?.[HISTORY_INDEX];
    if (historyRestoring) {
      if (target !== acceptedIndex && Number.isSafeInteger(target)) {
        history.go(acceptedIndex - target);
        return;
      }
      historyRestoring = false;
      const pending = pendingRoute;
      pendingRoute = null;
      if (pending?.kind === "push") navigate(pending.path);
      else if (pending?.kind === "replace") replaceRoute(pending.path);
      else if (pending?.kind === "url") replaceUrl(pending.path);
      return;
    }
    if (!allowRouteLeave()) {
      if (Number.isSafeInteger(target)) {
        historyRestoring = true;
        history.go(acceptedIndex - target);
      } else {
        // App entries carry an index. Preserve the accepted draft and URL if
        // an external same-document history writer supplied an unmarked entry.
        history.replaceState(acceptedState, "", acceptedUrl);
      }
      return;
    }
    changed();
  };
  window.addEventListener("popstate", traversed);
  window.addEventListener("route-change", changed);
  return () => {
    window.removeEventListener("popstate", traversed);
    window.removeEventListener("route-change", changed);
  };
}
