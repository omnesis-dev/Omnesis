// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
//
// Pinned requests on the watches page follow the gateway's signals. All
// fixture data is invented.

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  listSubscriptionApprovals: vi.fn(),
  listWatchV2Watches: vi.fn(),
  getWatchV2Watch: vi.fn(),
  getPrivacySubscription: vi.fn(),
}));
const signals = vi.hoisted(() => ({ emit: (_topic: string | null) => {}, setHealthy: (_healthy: boolean) => {} }));
vi.mock("../api.js", () => api);
vi.mock("../lib/portal-signals.js", async (importOriginal) =>
  (await import("../lib/portal-signals-fake.js")).mockPortalSignals(await importOriginal(), signals));

// @ts-expect-error — portal is plain JS without sibling declarations.
import { WatchesView } from "./watches.js";

const request = (id: string) => ({
  id,
  subscriptionId: `subscription-${id}`,
  integration: { displayName: "Fictional agent", source: "token" },
  status: "pending",
  interpretedCondition: { summary: "A fictional project update asks for a decision", pushDetail: "existence" },
  revision: 1,
  createdAt: 1_700_000_000_000,
  expiresAt: 1_700_003_600_000,
});

let host: HTMLElement;
beforeEach(() => {
  const parsed = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("main") as unknown as HTMLElement;
  api.listWatchV2Watches.mockReset().mockResolvedValue({ watches: [] });
  api.listSubscriptionApprovals.mockReset().mockResolvedValue({ approvals: [], nextCursor: null, totalCount: 0 });
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
}

test("a watch request signalled by the gateway is pinned without a reload, and leaves once decided", async () => {
  await act(async () => render(h(WatchesView, {}), host));
  await settle();
  expect(host.querySelectorAll(".privacy-approval-row")).toHaveLength(0);

  api.listSubscriptionApprovals.mockResolvedValue({ approvals: [request("w1")], nextCursor: null, totalCount: 1 });
  signals.emit("answers");
  await settle();
  expect(api.listSubscriptionApprovals).toHaveBeenCalledTimes(1);

  signals.emit("watches");
  await settle();
  expect(api.listSubscriptionApprovals).toHaveBeenCalledTimes(2);
  expect(api.listSubscriptionApprovals).toHaveBeenLastCalledWith({ status: "pending", limit: 50 });
  expect(host.querySelectorAll(".privacy-approval-row")).toHaveLength(1);
  expect(host.textContent).not.toContain("Loading watches");

  api.listSubscriptionApprovals.mockResolvedValue({ approvals: [], nextCursor: null, totalCount: 0 });
  signals.emit(null);
  await settle();
  expect(host.querySelectorAll(".privacy-approval-row")).toHaveLength(0);
});
