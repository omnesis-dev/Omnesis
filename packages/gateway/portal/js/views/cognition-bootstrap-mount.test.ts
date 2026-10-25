// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getCognitionBootstrap: vi.fn(),
  getCognitionBudget: vi.fn(),
  getCognitionBootstrapTimeline: vi.fn(),
  getStatus: vi.fn(),
}));
vi.mock("../api.js", async (original) => ({ ...(await original<Record<string, unknown>>()), ...api }));
// @ts-expect-error — portal is plain JS without sibling declarations.
import { BootstrapTab } from "./cognition-bootstrap.js";

let host: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  // Keep effect scheduling real, but never allow a polling tick.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("window", dom.window);
  host = dom.document.querySelector("main") as unknown as HTMLElement;
  api.getStatus.mockResolvedValue({ brain: { active: true } });
  api.getCognitionBudget.mockResolvedValue(null);
  api.getCognitionBootstrapTimeline.mockResolvedValue({ months: [] });
  api.getCognitionBootstrap.mockResolvedValue({
    mode: "knowledge", state: "running", reason: "Discovery is running.",
    settings: { enabled: true },
    admission: { today: 0, total: 0, pending: 0, batched: 0, completed: 0 },
    revisionCoverage: [], conversion: [],
  });
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("loads status and budget on each mount without waiting for the polling interval", async () => {
  for (let mount = 1; mount <= 2; mount++) {
    await act(async () => render(h(BootstrapTab, {}), host));
    await act(async () => { await Promise.resolve(); });
    expect(api.getCognitionBootstrap).toHaveBeenCalledTimes(mount);
    expect(api.getCognitionBudget).toHaveBeenCalledTimes(mount);
    expect(host.textContent).not.toContain("Loading discovery status");
    expect(host.textContent).toContain("Discovery is running.");
    await act(async () => render(null, host));
  }
});

it("shows an initial request failure without waiting for a polling retry", async () => {
  api.getCognitionBootstrap.mockRejectedValue(new Error("Discovery temporarily unavailable"));
  await act(async () => render(h(BootstrapTab, {}), host));
  // Rejection flows through the catch after the resolved gate request.
  await act(async () => { await Promise.resolve(); });
  expect(api.getCognitionBootstrap).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Discovery temporarily unavailable");
  expect(host.textContent).not.toContain("Loading discovery status");
});
