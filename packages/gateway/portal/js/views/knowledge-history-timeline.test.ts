// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
// @ts-expect-error — portal modules are plain JavaScript.
import { KnowledgeHistoryTimeline, coverageTotals } from "./knowledge-history-timeline.js";

const months = [
  { month: "2025-01", interpretation: { considered: 4, gated: 2, deferred: 1, failed: 1, pending: 2 },
    organization: { considered: 1, gated: 2, deferred: 2, failed: 0, pending: 5 } },
  { month: null, interpretation: { considered: 0, gated: 0, deferred: 0, failed: 0, pending: 3 },
    organization: { considered: 0, gated: 0, deferred: 0, failed: 0, pending: 3 } },
];
let host: HTMLElement;
beforeEach(() => {
  const { document, window } = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  host = document.querySelector("main") as unknown as HTMLElement;
});
afterEach(() => { render(null, host); vi.unstubAllGlobals(); });

it("keeps phase coverage, skipped evidence, outstanding work and undated sources distinct", () => {
  expect(coverageTotals(months, "interpretation")).toEqual({
    considered: 4, gated: 2, deferred: 1, failed: 1, pending: 5, total: 13,
  });
  expect(coverageTotals(months, "organization")).toEqual({
    considered: 1, gated: 2, deferred: 2, failed: 0, pending: 8, total: 13,
  });
});

it("renders accessible monthly counts and switches phase without implying synthesis completion", async () => {
  let phase = "interpretation";
  const update = () => render(h(KnowledgeHistoryTimeline, {
    timeline: { mode: "knowledge", months }, phase,
    onPhaseChange: (value: string) => { phase = value; update(); },
  }), host);
  await act(async () => { update(); });
  expect(host.textContent).toContain("4 of 13 documents read");
  const columns = host.querySelectorAll<HTMLElement>('[role="img"]');
  expect(columns).toHaveLength(2);
  expect(columns[0].getAttribute("aria-label")).toContain("Jan 2025 · 10 source documents");
  expect(columns[1].getAttribute("aria-label")).toContain("Undated · 3 source documents");
  const connect = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.includes("Connect context"))!;
  await act(async () => { connect.click(); });
  expect(host.textContent).toContain("1 of 13 documents reviewed for connections");
  expect(host.textContent).toContain("reviewed for connections");
  expect(host.textContent).toContain("A review need not create a wiki page");
  expect(host.textContent).toContain("History outside your source sync range is not shown");
});

it("keeps the last measured chart visible if refreshing fails", async () => {
  await act(async () => { render(h(KnowledgeHistoryTimeline, {
    timeline: { mode: "knowledge", months }, error: "Temporarily unavailable",
  }), host); });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Temporarily unavailable");
  expect(host.querySelectorAll('[role="img"]')).toHaveLength(2);
});
