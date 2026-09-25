// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Portal light/dark theme preference — runtime read/write + live application.
//
// The active theme is the value of `data-theme` on <html>. An inline script in
// index.html sets it before first paint (reading THEME_KEY from localStorage,
// default "dark") so there's no flash of the wrong palette on load. This module
// owns the preference at runtime: it persists changes, keeps the mobile browser
// chrome colour in sync, and fires an `omnesis:themechange` event for the few
// surfaces that can't observe CSS custom properties (the QR canvas redraws on
// it). Everything else re-themes automatically because it reads the tokens
// defined in style.css, which `[data-theme="light"]` overrides.

export const THEME_KEY = "omnesis.theme";

/** The page background per theme — mirrors --bg-primary, used for the
 *  `<meta name="theme-color">` that tints mobile browser chrome. */
const META_COLOR = { dark: "#0d1117", light: "#ffffff" };

/** The currently-applied theme ("dark" | "light"), read off <html>. */
export function getTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/**
 * Apply `theme`, persist it, sync the browser-chrome colour, and notify
 * non-CSS surfaces. Anything other than "light" resolves to "dark".
 */
export function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* private mode / quota — the in-DOM attribute still holds for the session */
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", META_COLOR[next]);
  window.dispatchEvent(new CustomEvent("omnesis:themechange", { detail: { theme: next } }));
  return next;
}

/** Flip dark↔light and return the new theme. */
export function toggleTheme() {
  return applyTheme(getTheme() === "light" ? "dark" : "light");
}
