// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The Settings page's tab set, in display order. Owned here rather than in
// the view because the router needs it too: it validates the
// `/portal/settings/<tab>` segment, resolves the bare `/portal/settings` to
// the default tab, and knows which tabs address a section below themselves —
// a second copy of any of that would drift.
//
// Order runs from the gateway outward: the config file that defines it, the
// standing instructions its agent runs under, the models that power its
// capabilities, the scheduled passes it makes over the corpus, delegated data
// access, the privacy policies that access is reviewed under, then the
// operational devices allowed to talk to it.
//
// `experimental` marks a tab that only exists when the gateway runs in
// experimental mode. It stays in `SETTINGS_TAB_KEYS` regardless, so the router
// still parses its path and the view — which knows the mode — decides whether
// to render it or fall back.
//
// `ownsSection` marks a tab that addresses one level deeper
// (`/portal/settings/models/<capability>`). Without it the router would have
// to know one tab's shape by name.

const TABS = [
  { key: "config", label: "Config" },
  // Keyed `omnesis-md` rather than `omnesis.md`: the router's tab segment
  // pattern accepts lower-case letters and hyphens only, so a dot in the key
  // would make the tab unreachable by URL.
  { key: "omnesis-md", label: "OMNESIS.md" },
  { key: "models", label: "Models", ownsSection: true },
  { key: "sweeps", label: "Sweeps", experimental: true },
  { key: "access", label: "Access" },
  { key: "policies", label: "Policies" },
  { key: "devices", label: "Devices" },
];

/** Every tab key — what the router accepts as a path segment. */
export const SETTINGS_TAB_KEYS = TABS.map((t) => t.key);

/** The tab the bare `/portal/settings` opens. */
export const DEFAULT_SETTINGS_TAB = TABS[0].key;

/** Tab keys that address a section below themselves. */
export const SETTINGS_TABS_WITH_SECTION = TABS.filter((t) => t.ownsSection).map((t) => t.key);

/** Tab keys that only exist in experimental mode. */
export const EXPERIMENTAL_SETTINGS_TABS = TABS.filter((t) => t.experimental).map((t) => t.key);

/** The tab set to render, in display order. */
export function settingsTabs({ experimental = false } = {}) {
  return TABS.filter((t) => experimental || !t.experimental).map(({ key, label }) => ({
    key,
    label,
  }));
}
