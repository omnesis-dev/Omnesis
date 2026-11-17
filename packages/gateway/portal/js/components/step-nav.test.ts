// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { StepNav, useStepFocus } from "./step-nav.js";

let host: HTMLElement;
beforeEach(() => {
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("window", dom.window);
  host = dom.document.querySelector("main") as unknown as HTMLElement;
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

const items = [
  { key: "a", label: "First", current: false, complete: true },
  { key: "b", label: "Second", current: true, complete: false },
  { key: "c", label: "Third", current: false, complete: false },
];

test("ticks finished steps, marks the current one and holds the rest", async () => {
  const onSelect = vi.fn();
  await act(async () => render(h(StepNav, { items, onSelect }), host));
  const buttons = [...host.querySelectorAll("nav.access-wizard-steps button")] as HTMLButtonElement[];
  expect(host.querySelector("nav")?.getAttribute("aria-label")).toBe("Progress");
  expect(buttons.map((b) => b.textContent)).toEqual(["✓First", "2Second", "3Third"]);
  expect(buttons.map((b) => b.className)).toEqual(["is-complete", "is-current", ""]);
  expect(buttons.map((b) => b.getAttribute("aria-current"))).toEqual([null, "step", null]);
  expect(buttons.map((b) => b.hasAttribute("disabled"))).toEqual([false, false, true]);
  await act(async () => buttons[0].click());
  await act(async () => buttons[1].click());
  expect(onSelect.mock.calls).toEqual([["a"]]);
  await act(async () => render(h(StepNav, { items, onSelect, disabled: true }), host));
  expect([...host.querySelectorAll("button")].every((b) => b.hasAttribute("disabled"))).toBe(true);
});

test("a step the flow marks reachable can be clicked ahead, keeping its number", async () => {
  const onSelect = vi.fn();
  const ahead = [items[0], items[1], { ...items[2], reachable: true }];
  await act(async () => render(h(StepNav, { items: ahead, onSelect }), host));
  const buttons = [...host.querySelectorAll("nav.access-wizard-steps button")] as HTMLButtonElement[];
  expect(buttons.map((b) => b.textContent)).toEqual(["✓First", "2Second", "3Third"]);
  expect(buttons.map((b) => b.hasAttribute("disabled"))).toEqual([false, false, false]);
  await act(async () => buttons[2].click());
  await act(async () => buttons[1].click());
  expect(onSelect.mock.calls).toEqual([["c"]]);
});

test("focus follows the step, but not on the first render", async () => {
  function Step({ step }: { step: number }) {
    const ref = useStepFocus(step);
    return h("h3", { ref, tabIndex: -1 }, `Step ${step}`);
  }
  await act(async () => render(h(Step, { step: 1 }), host));
  const heading = host.querySelector("h3") as HTMLElement;
  const focus = vi.fn();
  heading.focus = focus;
  await act(async () => render(h(Step, { step: 1 }), host));
  expect(focus).not.toHaveBeenCalled();
  await act(async () => render(h(Step, { step: 2 }), host));
  expect(focus).toHaveBeenCalledOnce();
});
