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
// access, the privacy policies that access is reviewed under, the
// operational devices allowed to talk to it, then how those devices reach it
// from away from home.
//
// `experimental` marks a tab that only exists when the gateway runs in
// experimental mode. It stays in `SETTINGS_TAB_KEYS` regardless, so the router
// still parses its path and the view — which knows the mode — decides whether
// to render it or fall back.
//
// `cloudRelay` and `tailscaleEmbed` mark a tab that only exists when the
// gateway runs with that optional feature on; like experimental tabs, the
// router keeps their keys and the view decides.
//
// `parent` marks a detail page: it has its own path, but no tab of its own —
// the tab bar shows its parent as the current tab.
//
// `ownsSection` marks a tab that addresses one level deeper
// (`/portal/settings/models/<capability>`). Without it the router would have
// to know one tab's shape by name.

const TABS = [
  { key: "config", label: "Config" },
  { key: "lab", label: "Omnesis Lab", experimental: true },
  { key: "storage", label: "Storage" },
  // Keyed `omnesis-md` rather than `omnesis.md`: the router's tab segment
  // pattern accepts lower-case letters and hyphens only, so a dot in the key
  // would make the tab unreachable by URL.
  { key: "omnesis-md", label: "OMNESIS.md" },
  { key: "models", label: "Models", ownsSection: true },
  { key: "sweeps", label: "Sweeps", experimental: true },
  { key: "access", label: "Access" },
  { key: "policies", label: "Policies" },
  { key: "devices", label: "Devices" },
  { key: "connectivity", label: "Connectivity" },
  { key: "account", label: "Omnesis account", cloudRelay: true, parent: "connectivity" },
  { key: "relay", label: "Omnesis relay", cloudRelay: true, parent: "connectivity" },
  { key: "host-tailscale", label: "Tailscale on this computer", parent: "connectivity" },
  { key: "own-address", label: "Your own domain", parent: "connectivity" },
  { key: "mcp", label: "MCP server", parent: "connectivity" },
  { key: "tailscale", label: "Tailscale", tailscaleEmbed: true, parent: "connectivity" },
];

/**
 * Tab keys that were renamed, with the key each now lives under: the router
 * resolves the old one to the new and redirects, so bookmarks keep working.
 */
export const SETTINGS_TAB_RENAMES = { "remote-access": "connectivity" };

/** Every tab key — what the router accepts as a path segment. */
export const SETTINGS_TAB_KEYS = TABS.map((t) => t.key);

/** The tab the bare `/portal/settings` opens. */
export const DEFAULT_SETTINGS_TAB = TABS[0].key;

/** Tab keys that address a section below themselves. */
export const SETTINGS_TABS_WITH_SECTION = TABS.filter((t) => t.ownsSection).map((t) => t.key);

/** Tab keys that only exist in experimental mode. */
export const EXPERIMENTAL_SETTINGS_TABS = TABS.filter((t) => t.experimental).map((t) => t.key);

/** The tab whose page a detail page belongs to, or null for a tab of its own. */
export function settingsTabParent(key) {
  return TABS.find((t) => t.key === key)?.parent ?? null;
}

/** Whether a tab or detail page exists for the gateway's optional features. */
export function settingsTabAvailable(key, { cloudRelay = false, tailscaleEmbed = false } = {}) {
  const tab = TABS.find((t) => t.key === key);
  if (!tab) return false;
  return (!tab.cloudRelay || cloudRelay) && (!tab.tailscaleEmbed || tailscaleEmbed);
}

/** The tab set to render, in display order. */
export function settingsTabs({ experimental = false, brain = experimental, labAvailable = false, cloudRelay = false, tailscaleEmbed = false } = {}) {
  return TABS.filter((t) => !t.parent && (!t.experimental || experimental) && (t.key !== "sweeps" || brain) && (t.key !== "lab" || labAvailable) && settingsTabAvailable(t.key, { cloudRelay, tailscaleEmbed })).map(({ key, label }) => ({
    key,
    label,
  }));
}
