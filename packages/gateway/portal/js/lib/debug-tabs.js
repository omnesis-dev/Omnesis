// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The Debug page's tab set, in display order. Owned here rather than in the
// view because the router needs it too: it validates the `/portal/debug/<tab>`
// segment and resolves the bare `/portal/debug` to the default tab, and a
// second copy of the list would drift.
//
// Order runs from the stores outward: what the data *is* (Data, SQL, Graph),
// then how the process is behaving (Metrics, Background Jobs), then the
// derived cognitive state and the health check.
//
// The Cognition tab (the read-only Cognition Steward cognitive-state
// inspector) and the Watch tab (one watch's definition, drawn as the graph the
// runtime evaluates) are EXPERIMENTAL — the tab bar offers them only when the
// gateway advertises experimental mode via `GET /status`, exactly like the
// Watches nav item. The router still resolves their paths in either mode, so a
// deep link lands on the right tab the moment the flag arrives.

const TABS = [
  { key: "data", label: "Data" },
  { key: "sql", label: "SQL" },
  { key: "graph", label: "Graph" },
  { key: "metrics", label: "Metrics" },
  { key: "background-jobs", label: "Background Jobs" },
  { key: "cognition", label: "Cognition", experimental: true },
  { key: "watch", label: "Watch", experimental: true },
  { key: "doctor", label: "Doctor" },
];

/** Every tab key, including experimental ones — what the router accepts. */
export const DEBUG_TAB_KEYS = TABS.map((t) => t.key);

/** The tab the bare `/portal/debug` opens. */
export const DEFAULT_DEBUG_TAB = TABS[0].key;

/**
 * The tab set to render for the current experimental mode. Dropping the
 * experimental tabs keeps them off the tab bar for a stock install — the
 * single gate that mirrors the Watches nav item.
 */
export function debugTabs(experimental) {
  return TABS.filter((t) => !t.experimental || experimental).map(({ key, label }) => ({
    key,
    label,
  }));
}
