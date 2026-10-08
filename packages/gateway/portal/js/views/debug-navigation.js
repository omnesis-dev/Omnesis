// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { navigate } from "../lib/router.js";

const brain = (key, label) => ({ key: `cognition/${key}`, label, experimental: true });
const GROUPS = [
  {
    key: "knowledge",
    label: "Knowledge",
    items: [
      brain("knowledge", "Library"),
      brain("loops", "Loops"),
      brain("briefs", "Briefs"),
      { key: "calendar", label: "Timeline" },
    ],
  },
  {
    key: "brain",
    label: "Brain activity",
    items: [
      brain("overview", "Activity"),
      brain("runs", "Agent runs"),
      brain("maintenance", "Maintenance"),
      brain("bootstrap", "Discovery"),
      brain("calibration", "Calibration"),
      brain("memory", "Legacy memory"),
    ],
  },
  {
    key: "system",
    label: "System",
    items: [
      { key: "doctor", label: "Health" },
      { key: "metrics", label: "Metrics" },
      { key: "background-jobs", label: "Gateway jobs" },
      { key: "watch", label: "Watch runtime", experimental: true },
    ],
  },
  {
    key: "data",
    label: "Data tools",
    items: [
      { key: "data", label: "Tables" },
      { key: "sql", label: "SQL" },
      { key: "graph", label: "Document graph" },
    ],
  },
];

export function debugNavigation(experimental, tab, cognitionTab) {
  const groups = GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.experimental || experimental),
  })).filter((group) => group.items.length);
  const requested = cognitionTab === "scheduled" ? "runs" : cognitionTab || "overview";
  const section = GROUPS.some((group) =>
    group.items.some((item) => item.key === `cognition/${requested}`),
  )
    ? requested
    : "overview";
  const key = tab === "cognition" ? `cognition/${section}` : tab;
  const active =
    groups.find((group) => group.items.some((item) => item.key === key)) ??
    groups.find((group) => group.key === "data");
  return { groups, active, key };
}

function routeLink(event, key) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  event.preventDefault();
  navigate(`/portal/debug/${key}`);
}

export function DebugNavigation({ experimental, tab, cognitionTab }) {
  const { groups, active, key } = debugNavigation(experimental, tab, cognitionTab);
  return html`<header class="debug-navigation">
    <div class="debug-navigation-top">
      <a class="debug-navigation-home" href="/portal/debug" onClick=${(e) => routeLink(e, "data")}
        >Debug</a
      >
      <nav aria-label="Debug areas" class="debug-area-links">
        ${groups.map(
          (group) =>
            html`<a
              key=${group.key}
              class=${group.key === active.key ? "is-active" : ""}
              aria-current=${group.key === active.key ? "true" : undefined}
              href=${`/portal/debug/${group.items[0].key}`}
              onClick=${(e) => routeLink(e, group.items[0].key)}
              >${group.label}</a
            >`,
        )}
      </nav>
    </div>
    <nav aria-label=${`${active.label} views`} class="debug-section-links">
      ${active.items.map(
        (item) =>
          html`<a
            key=${item.key}
            class=${key === item.key ? "is-active" : ""}
            aria-current=${key === item.key ? "page" : undefined}
            href=${`/portal/debug/${item.key}`}
            onClick=${(e) => routeLink(e, item.key)}
            >${item.label}</a
          >`,
      )}
    </nav>
  </header>`;
}
