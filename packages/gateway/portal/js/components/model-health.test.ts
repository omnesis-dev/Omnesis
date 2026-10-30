// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../lib/router.js", () => ({ navigate: vi.fn() }));
// @ts-expect-error — portal modules are plain JS.
import { ModelHealthWarnings } from "./model-health.js";
// @ts-expect-error — portal modules are plain JS.
import { CapabilityGrid, CapabilityDetail } from "../views/models.js";
// @ts-expect-error — portal modules are plain JS.
import { navigate } from "../lib/router.js";

const failure = {
  role: "agent", assignment: "example/model", consecutiveFailures: 4,
  firstFailedAt: 1000, lastFailedAt: 2000, category: "quota",
  message: "The provider reports exhausted quota or credits. Check billing or choose another model.",
};
const overview = (warnings: object[]) => ({
  capabilities: [{ role: "agent", title: "Agent", icon: "bot" }],
  inference: { assignments: { agent: { kind: "http", available: true } }, health: { warnings } },
});

describe("model runtime warnings", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  test("explains the affected capability and links directly to its settings", async () => {
    await act(async () => { render(h(ModelHealthWarnings, { overview: overview([failure]) }), host); });
    expect(host.textContent).toContain("Agent: repeated model failures");
    expect(host.textContent).toContain(failure.message);
    expect(host.textContent).toContain("4 consecutive failed requests");
    expect(host.querySelector("time")?.getAttribute("datetime")).toBe("1970-01-01T00:00:02.000Z");
    const link = host.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/portal/settings/models/agent");
    link.click();
    expect(navigate).toHaveBeenCalledWith("/portal/settings/models/agent");
    await act(async () => { render(h(ModelHealthWarnings, { overview: overview([]) }), host); });
    expect(host.querySelector(".model-health-warning")).toBeNull();
  });

  test("marks the assigned model in capability details until recovery", async () => {
    const data = { ...overview([failure]), assignmentDisplays: {
      agent: { providerLabel: "Example provider", modelName: "Example model" },
    } };
    await act(async () => { render(h(CapabilityDetail, { role: "agent", overview: data }), host); });
    expect(host.querySelector('.cap-detail-active--warning [aria-label="Repeated model failures"]')).not.toBeNull();
    expect(host.querySelector(".cap-detail-tick")).toBeNull();
    await act(async () => { render(h(CapabilityDetail, { role: "agent", overview: {
      ...data, inference: { ...data.inference, health: { warnings: [] } },
    } }), host); });
    expect(host.querySelector(".cap-detail-tick")).not.toBeNull();
    expect(host.querySelector(".cap-detail-active--warning")).toBeNull();
  });

  test("shows only served capabilities and scopes a detail page to its own failures", async () => {
    const data = overview([failure, { ...failure, role: "draft-decision" }]);
    await act(async () => { render(h(ModelHealthWarnings, { overview: data }), host); });
    expect(host.querySelectorAll(".model-health-warning")).toHaveLength(1);
    await act(async () => { render(h(ModelHealthWarnings, { overview: data, role: "embedder" }), host); });
    expect(host.querySelector(".model-health-warning")).toBeNull();
    await act(async () => { render(h(ModelHealthWarnings, { overview: data, role: "agent" }), host); });
    expect(host.querySelectorAll(".model-health-warning")).toHaveLength(1);
    expect(host.querySelector("a")).toBeNull();
  });

  test("replaces a healthy connection tick with a runtime warning until success", async () => {
    await act(async () => { render(h(CapabilityGrid, { overview: overview([failure]) }), host); });
    expect(host.querySelector('.cap-card [aria-label="Repeated model failures"]')).not.toBeNull();
    expect(host.querySelector(".cap-card-tick")).toBeNull();
    expect(host.textContent).toContain("Needs attention");
    await act(async () => { render(h(CapabilityGrid, { overview: overview([]) }), host); });
    expect(host.querySelector(".cap-card-tick")).not.toBeNull();
    expect(host.querySelector(".warning-triangle")).toBeNull();
  });
});
