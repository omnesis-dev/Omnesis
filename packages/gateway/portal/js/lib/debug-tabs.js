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
// Brain and Watch require their own Lab opt-ins as well as experimental mode.
// Paths still resolve while a feature is off, so saved links can fall back to
// a stable tab without exposing the disabled inspector.

const TABS = [
  { key: "data", label: "Data" },
  { key: "sql", label: "SQL" },
  { key: "graph", label: "Graph" },
  { key: "metrics", label: "Metrics" },
  { key: "background-jobs", label: "Background Jobs" },
  { key: "calendar", label: "Calendar" },
  { key: "brain", label: "Brain", feature: "brain", experimental: true },
  { key: "watch", label: "Watch", feature: "watches", experimental: true },
  { key: "doctor", label: "Doctor" },
];

/** Every tab key, including experimental ones — what the router accepts. */
export const DEBUG_TAB_KEYS = TABS.map((t) => t.key);

/** The tab the bare `/portal/debug` opens. */
export const DEFAULT_DEBUG_TAB = TABS[0].key;

/**
 * The tab set to render for the gateway mode and independent Lab opt-ins.
 */
export function debugTabs(experimental, lab = { brain: experimental, watches: experimental }) {
  return TABS.filter((t) => !t.experimental || (experimental && lab[t.feature] === true)).map(({ key, label }) => ({
    key,
    label,
  }));
}
