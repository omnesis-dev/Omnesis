// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const cloud = vi.hoisted(() => ({
  cloudPairingConfig: vi.fn(),
  cloudPairingRequests: vi.fn(),
  decideCloudPairing: vi.fn(),
  askBeforeEveryNewDevice: vi.fn(),
}));
const tailscale = vi.hoisted(() => ({ tailscaleJoinRequests: vi.fn(), decideTailscaleJoin: vi.fn() }));
const signals = vi.hoisted(() => ({ emit: (_topic: string | null) => {}, setHealthy: (_healthy: boolean) => {} }));
vi.mock("../lib/cloud-pairing-api.js", () => cloud);
vi.mock("../lib/tailscale-api.js", () => tailscale);
vi.mock("../lib/portal-signals.js", async (importOriginal) =>
  (await import("../lib/portal-signals-fake.js")).mockPortalSignals(await importOriginal(), signals));

// @ts-expect-error — portal modules are plain JS.
import { WaitingDevices } from "./waiting-devices.js";
// @ts-expect-error — portal modules are plain JS.
import { expiresIn } from "./tailscale-join-requests.js";

const join = (id: string, more: Record<string, unknown> = {}) => ({
  id,
  name: "studio-laptop",
  kind: "collector",
  machine: "studio-laptop",
  os: "macOS",
  login: "maya@example.com",
  requestedAt: new Date(Date.now() - 120_000).toISOString(),
  expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
  ...more,
});
const relayRequest = {
  requestId: "r1",
  name: "Fictional phone",
  kind: "ios",
  signIn: "passkey",
  status: "pending",
  verificationCode: "123 456",
  createdAt: Date.now(),
  expiresAt: Date.now() + 600_000,
};

let host: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("window", dom.window);
  host = dom.document.querySelector("main") as unknown as HTMLElement;
  cloud.cloudPairingConfig.mockResolvedValue({ clientId: "fictional-client" });
  cloud.cloudPairingRequests.mockResolvedValue({ items: [] });
  tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [] });
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}
async function show(props: Record<string, unknown>) {
  await act(async () => render(h(WaitingDevices, props), host));
  await settle();
}
const text = () => (host.textContent ?? "").replace(/\s+/g, " ");
const titles = () => [...host.querySelectorAll("h2")].map((title) => title.textContent);
async function click(label: string, within: Element = host) {
  const target = [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  expect(target, `button "${label}"`).toBeTruthy();
  await act(async () => (target as HTMLButtonElement).click());
  await settle();
}

describe("expiresIn", () => {
  test("counts down in minutes and says when it has passed", () => {
    const now = Date.parse("2026-05-01T10:00:00Z");
    expect(expiresIn(new Date(now + 8.2 * 60_000).toISOString(), now)).toBe("expires in 9 min");
    expect(expiresIn(new Date(now + 20_000).toISOString(), now)).toBe("expires in under a minute");
    expect(expiresIn(new Date(now - 1).toISOString(), now)).toBe("expired");
    expect(expiresIn("not a date", now)).toBe("");
  });
});

describe("WaitingDevices", () => {
  test("without sign-in pairing or a Tailscale device it shows an empty section and asks for no requests", async () => {
    cloud.cloudPairingConfig.mockResolvedValue(null);
    await show({});
    const section = host.querySelector("section.cloud-pairing-requests") as HTMLElement;
    expect(section.children).toHaveLength(0);
    expect(cloud.cloudPairingConfig).toHaveBeenCalled();
    expect(cloud.cloudPairingRequests).not.toHaveBeenCalled();
    expect(tailscale.tailscaleJoinRequests).not.toHaveBeenCalled();
  });

  test("without a Tailscale device: never asks for Tailscale requests", async () => {
    cloud.cloudPairingRequests.mockResolvedValue({ items: [relayRequest] });
    await show({});
    expect(titles()).toEqual(["Waiting for your OK"]);
    expect(text()).toContain("Fictional phone wants to connect");
    expect(tailscale.tailscaleJoinRequests).not.toHaveBeenCalled();
  });

  test("nothing waiting: an empty section that the page hides", async () => {
    await show({ tailscaleEmbed: true });
    const section = host.querySelector("section.cloud-pairing-requests") as HTMLElement;
    expect(section.children).toHaveLength(0);
    expect(titles()).toEqual([]);
  });

  test("both kinds under one title, each saying how it asked", async () => {
    cloud.cloudPairingRequests.mockResolvedValue({ items: [relayRequest] });
    tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [join("t1")] });
    await show({ tailscaleEmbed: true });
    expect(titles()).toEqual(["Waiting for your OK"]);
    const cards = [...host.querySelectorAll("article")];
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "Fictional phone wants to connect",
      "studio-laptop wants to connect",
    ]);
    const ts = cards[1].textContent?.replace(/\s+/g, " ") ?? "";
    expect(ts).toMatch(/Collector · via Tailscale · maya@example\.com · asked .+ · expires in (8|9) min/);
    expect(ts).toContain("It asks from studio-laptop (macOS), a device on your Tailscale network signed in as maya@example.com.");
    expect(ts).toContain("Is studio-laptop one of your devices?");
  });

  test("Tailscale joins without sign-in pairing: approving says so, and the card leaves", async () => {
    cloud.cloudPairingConfig.mockResolvedValue(null);
    tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [join("t1"), join("t2", { expiresAt: new Date(Date.now() - 1).toISOString() })] });
    await show({ tailscaleEmbed: true });
    expect(cloud.cloudPairingRequests).not.toHaveBeenCalled();
    expect(host.querySelectorAll("article")).toHaveLength(1);
    tailscale.decideTailscaleJoin.mockResolvedValue({ status: "approved" });
    tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [] });
    await click("Yes, approve");
    expect(tailscale.decideTailscaleJoin).toHaveBeenCalledWith("t1", true);
    expect(host.querySelectorAll("article")).toHaveLength(0);
    expect(titles()).toEqual([]);
    expect(text()).toContain("Approved studio-laptop. It joins within a few seconds.");
  });

  test("denying, a request decided elsewhere, and a refusal that stays on the card", async () => {
    tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [join("t1")] });
    await show({ tailscaleEmbed: true });
    tailscale.decideTailscaleJoin.mockResolvedValueOnce({ status: "denied" });
    await click("No, deny");
    expect(tailscale.decideTailscaleJoin).toHaveBeenCalledWith("t1", false);
    expect(text()).toContain("Denied studio-laptop.");

    render(null, host);
    await show({ tailscaleEmbed: true });
    tailscale.decideTailscaleJoin.mockRejectedValueOnce(Object.assign(new Error("gone"), { status: 404 }));
    await click("Yes, approve");
    expect(text()).toContain("This request expired or was already decided.");
    expect(host.querySelector('[role="alert"]')).toBeNull();

    render(null, host);
    tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [join("t1")] });
    await show({ tailscaleEmbed: true });
    tailscale.decideTailscaleJoin.mockRejectedValueOnce(
      Object.assign(new Error("failed"), { status: 403, serverMessage: "Your passkey was not accepted." }),
    );
    await click("Yes, approve");
    const card = host.querySelector("article") as HTMLElement;
    expect(card.querySelector('[role="alert"]')?.textContent).toBe("Your passkey was not accepted.");
  });

  test("a read that still lists an answered request does not bring its card back", async () => {
    tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [join("t1")] });
    await show({ tailscaleEmbed: true });
    tailscale.decideTailscaleJoin.mockResolvedValue({ status: "approved" });
    // The gateway's list has not caught up yet.
    await click("Yes, approve");
    expect(tailscale.tailscaleJoinRequests).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll("article")).toHaveLength(0);
    expect(titles()).toEqual([]);
  });

  test("the line about an answer fades after a few seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [join("t1")] });
      await show({ tailscaleEmbed: true });
      tailscale.decideTailscaleJoin.mockResolvedValue({ status: "denied" });
      tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [] });
      await click("No, deny");
      expect(text()).toContain("Denied studio-laptop.");
      await act(async () => {
        vi.advanceTimersByTime(8000);
      });
      expect(text()).not.toContain("Denied studio-laptop.");
    } finally {
      vi.useRealTimers();
    }
  });

  test("both kinds are read again when the gateway signals waiting devices changed, and only then", async () => {
    cloud.cloudPairingRequests.mockResolvedValue({ items: [] });
    await show({ tailscaleEmbed: true });
    expect(cloud.cloudPairingRequests).toHaveBeenCalledTimes(1);
    expect(tailscale.tailscaleJoinRequests).toHaveBeenCalledTimes(1);
    signals.emit("answers");
    await settle();
    expect(tailscale.tailscaleJoinRequests).toHaveBeenCalledTimes(1);
    cloud.cloudPairingRequests.mockResolvedValue({ items: [relayRequest] });
    tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [join("t1")] });
    signals.emit("devices");
    await settle();
    expect(cloud.cloudPairingRequests).toHaveBeenCalledTimes(2);
    expect(tailscale.tailscaleJoinRequests).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll("article")).toHaveLength(2);
    expect(titles()).toEqual(["Waiting for your OK"]);
  });

  test("a join request is read again just after it expires, and on an interval while the signals are down", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    signals.setHealthy(true);
    try {
      tailscale.tailscaleJoinRequests.mockResolvedValue({
        requests: [join("t1", { expiresAt: new Date(Date.now() + 20_000).toISOString() })],
      });
      await show({ tailscaleEmbed: true });
      expect(host.querySelectorAll("article")).toHaveLength(1);
      tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [] });
      await act(async () => {
        vi.advanceTimersByTime(20_500);
      });
      await settle();
      expect(tailscale.tailscaleJoinRequests).toHaveBeenCalledTimes(2);
      expect(host.querySelectorAll("article")).toHaveLength(0);
      // Healthy signals: no reads on an interval.
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(tailscale.tailscaleJoinRequests).toHaveBeenCalledTimes(2);
      await act(async () => {
        signals.setHealthy(false);
      });
      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });
      expect(tailscale.tailscaleJoinRequests).toHaveBeenCalledTimes(3);
    } finally {
      signals.setHealthy(false);
      vi.useRealTimers();
    }
  });

  test("a failed read shows the reason and the next read clears it", async () => {
    tailscale.tailscaleJoinRequests.mockRejectedValueOnce(Object.assign(new Error("x"), { serverMessage: "Gateway busy." }));
    await show({ tailscaleEmbed: true });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Gateway busy.");
    tailscale.tailscaleJoinRequests.mockResolvedValue({ requests: [] });
    await act(async () => {
      document.dispatchEvent(new window.Event("visibilitychange"));
    });
    await settle();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
