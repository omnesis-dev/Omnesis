// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({ getLab: vi.fn(), setLabFeature: vi.fn() }));
vi.mock("../api.js", () => api);
// @ts-expect-error — portal modules are plain JS.
import { LabView } from "./lab.js";
let host: HTMLElement;
const feature = { id: "brain", name: "Brain", description: "Processes data in the background.", iconSvg: '<svg viewBox="0 0 24 24"/>', enabled: false };
beforeEach(() => {
  vi.clearAllMocks();
  const parsed = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("main") as unknown as HTMLElement;
  api.getLab.mockResolvedValue({ features: [feature] });
});
afterEach(() => { render(null, host); vi.unstubAllGlobals(); });
test("saves the selected experiment then refreshes app capabilities", async () => {
  const onChange = vi.fn();
  api.setLabFeature.mockResolvedValue({ features: [{ ...feature, enabled: true }] });
  await act(async () => { render(h(LabView, { onChange }), host); });
  await act(async () => {});
  expect(host.textContent).toContain(feature.description);
  const toggle = host.querySelector('[role="switch"]') as HTMLButtonElement;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await act(async () => { toggle.click(); });
  expect(api.setLabFeature).toHaveBeenCalledWith("brain", true);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(onChange).toHaveBeenCalledOnce();
});
test("failed saves preserve the last confirmed toggle and show the error", async () => {
  api.setLabFeature.mockRejectedValue(new Error("Could not save experiment"));
  await act(async () => { render(h(LabView, {}), host); });
  await act(async () => {});
  const toggle = host.querySelector('[role="switch"]') as HTMLButtonElement;
  await act(async () => { toggle.click(); });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(toggle.disabled).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not save experiment");
});
test("failed reads can be retried", async () => {
  api.getLab.mockRejectedValueOnce(new Error("Could not load experiments"));
  await act(async () => { render(h(LabView, {}), host); });
  await act(async () => {});
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => { (host.querySelector("button") as HTMLButtonElement).click(); });
  await act(async () => {});
  expect(host.querySelector('[role="switch"]')).not.toBeNull();
});
