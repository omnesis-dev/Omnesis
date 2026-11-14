// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
// @ts-expect-error — Portal modules are JavaScript.
import { CapabilityPills, FilterModePill, capabilityPillsLabel } from "./access-pills.js";

let host: HTMLElement;
beforeEach(() => {
  const dom = parseHTML("<html><body><div id='root'></div></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.document);
  host = dom.document.querySelector("#root") as unknown as HTMLElement;
});
afterEach(() => {
  act(() => render(null, host));
  vi.unstubAllGlobals();
});

test("every capability keeps its pill in the same order, muted when it is not held", async () => {
  await act(async () => render(h(CapabilityPills, { rules: { answer: {}, direct: {} } }), host));
  const pills = [...host.querySelectorAll(".capability-pill")];
  expect(pills.map((pill) => [pill.textContent, pill.className])).toEqual([
    ["Answer", "capability-pill capability-pill-answer"],
    ["Direct", "capability-pill capability-pill-direct"],
    ["Notes", "capability-pill capability-pill-notes is-off"],
  ]);
  expect(host.querySelector(".capability-pills")?.getAttribute("aria-label")).toBe(
    "Answer and Direct allowed, Notes not allowed",
  );
});

test("the row reads as one sentence for any combination", () => {
  expect(capabilityPillsLabel({ notes: {} })).toBe("Notes allowed, Answer and Direct not allowed");
  expect(capabilityPillsLabel({ answer: {}, direct: {}, notes: {} })).toBe(
    "Answer, Direct and Notes allowed",
  );
  expect(capabilityPillsLabel({})).toBe("Answer, Direct and Notes not allowed");
});

test("each filter mode pill explains what it shares", async () => {
  await act(async () =>
    render(
      h("div", null, h(FilterModePill, { action: "share" }), h(FilterModePill, { action: "hide" })),
      host,
    ),
  );
  expect(
    [...host.querySelectorAll(".access-pill")].map((pill) => [
      pill.textContent,
      pill.className,
      pill.getAttribute("title"),
    ]),
  ).toEqual([
    [
      "Share matching content",
      "access-pill is-only",
      "Only content that matches the criteria in the table below will be shared.",
    ],
    [
      "Hide matching content",
      "access-pill is-hide",
      "All content which does not match the criteria in the table below will be shared.",
    ],
  ]);
});

test("a rule action with no pill of its own reads as a saved filter", async () => {
  await act(async () => render(h(FilterModePill, { action: "redact" }), host));
  expect(host.querySelector(".access-pill")?.textContent).toBe("Saved filter");
});
