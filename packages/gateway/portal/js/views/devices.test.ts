// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  buildPairQrPayload: vi.fn(),
  getPairAddresses: vi.fn(),
  fleetUpdateTarget: vi.fn(async () => ({ targetVersion: null })),
  forgetDevice: vi.fn(),
  getFleetDoctor: vi.fn(async () => ({ devices: [] })),
  getNetworkIdentities: vi.fn(async () => ({ items: [] })),
  getDoctorReport: vi.fn(),
  listDevices: vi.fn(async () => ({ items: [] })),
  getAccessOverview: vi.fn(async () => ({ levels: [] })),
  listTokens: vi.fn(async () => ({ items: [] })),
  setDeviceAccessLevel: vi.fn(),
  pairDevice: vi.fn(),
  requestFleetDoctor: vi.fn(async () => ({ devices: [] })),
  requestFleetUpdate: vi.fn(),
  revokeDevice: vi.fn(),
  revokeTokenById: vi.fn(),
  whoami: vi.fn(async () => ({ deviceId: null })),
  withdrawRelayPushConsent: vi.fn(),
}));

vi.mock("../api.js", () => apiMocks);

// @ts-expect-error — portal is plain JS without sibling declarations.
import {
  agentConnectCommands,
  agentGatewayUrl,
  DeviceCard,
  DeviceHealth,
  DeviceRevocationImpact,
  DevicesView,
  deviceCorpusCredentialImpact,
  deviceKinds,
  notificationTransportLabel,
  PairInstructions,
  resolvePairKindRequest,
  swapHostForUrl,
  updatableDevices,
  updateChip,
  versionChip,
} from "./devices.js";

const healthReport = {
  ok: true,
  summary: { errors: 0, warnings: 0 },
  checks: [
    { section: "Gateway", id: "gateway.reachable", status: "pass", message: "Reachable" },
    {
      section: "Host",
      id: "host.service",
      status: "not-applicable",
      message: "Managed service check does not apply",
    },
  ],
};

describe("per-device health", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
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

  async function renderHealth(health: Record<string, unknown>, onRun = vi.fn()) {
    await act(async () => {
      render(h(DeviceHealth, { health, deviceName: "Fictional collector", onRun }), host);
    });
    return onRun;
  }

  test("offers the initial run and retries failures with their detail", async () => {
    const onRun = await renderHealth({ state: "not-run" });
    expect(host.textContent).toContain("Not checked");
    const button = host.querySelector("button") as HTMLButtonElement;
    expect(button.textContent).toContain("Run");
    expect(button.getAttribute("aria-label")).toBe(
      "Run health checks for Fictional collector",
    );
    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe(
      "Fictional collector health",
    );
    await act(async () => button.click());
    expect(onRun).toHaveBeenCalledOnce();

    await renderHealth({ state: "failed", detail: "Collector refused the request." });
    expect(host.textContent).toContain("Collector refused the request.");
    expect(host.querySelector("button")?.textContent).toContain("Retry");
  });

  test("explains pending and running states without presenting another action", async () => {
    await renderHealth({ state: "pending" });
    expect(host.textContent).toContain("will run when the collector reconnects");
    expect(host.querySelector("button")).toBeNull();

    await renderHealth({ state: "pending", online: true });
    expect(host.textContent).toContain("waiting for the collector to begin");
    expect(host.textContent).not.toContain("reconnects");

    await renderHealth({ state: "running" });
    expect(host.textContent).toContain("Running health checks");
    expect(host.querySelector("button")).toBeNull();
  });

  test("renders a completed grouped report, its N/A check, time, and rerun action", async () => {
    await renderHealth({
      state: "complete",
      completedAt: new Date().toISOString(),
      report: healthReport,
    });

    expect(host.textContent).toContain("Completed just now");
    expect(host.textContent).toContain("Gateway");
    expect(host.textContent).toContain("Host");
    expect(host.querySelector('.doctor-check-not-applicable [title="N/A"]')?.textContent).toBe(
      "—",
    );
    expect(host.querySelector("button")?.textContent).toContain("Run again");
  });

  test("renders a device-level not-applicable state neutrally", async () => {
    await renderHealth({ state: "not-applicable", detail: "This client has no host checks." });
    expect(host.textContent).toContain("N/A");
    expect(host.textContent).toContain("This client has no host checks.");
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector(".devices-health-failed")).toBeNull();
  });
});

describe("fleet health action", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
    apiMocks.listDevices.mockResolvedValue({ items: [] });
    apiMocks.getFleetDoctor.mockResolvedValue({ devices: [] });
    apiMocks.requestFleetDoctor.mockReset();
    apiMocks.requestFleetDoctor.mockResolvedValue({ devices: [] });
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  test("the global action requests all devices by omitting ids", async () => {
    await act(async () => {
      render(h(DevicesView, {}), host);
    });
    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Run health checks",
    ) as HTMLButtonElement;

    await act(async () => button.click());

    expect(apiMocks.requestFleetDoctor).toHaveBeenCalledWith(undefined);
    expect(host.querySelector(".devices-gateway-version")).toBeNull();
  });

  test("shows the gateway version beside the device summary when available", async () => {
    apiMocks.fleetUpdateTarget.mockResolvedValueOnce({ targetVersion: "1.4.0" });

    await act(async () => {
      render(h(DevicesView, {}), host);
    });

    await vi.waitFor(() =>
      expect(host.querySelector(".devices-gateway-version")?.textContent).toContain("Gateway version 1.4.0"),
    );
    expect(host.querySelectorAll(".devices-card")).toHaveLength(0);
  });

  test("a late repair response cannot cross into another device's modal", async () => {
    const rows = [
      { id: "device_a", name: "Fictional phone A", kind: "ios", online: false },
      { id: "device_b", name: "Fictional phone B", kind: "android", online: false },
    ].map((device, index) => ({
      ...device,
      pairedAt: index + 1,
      lastSeenAt: null,
      capabilities: {},
    }));
    apiMocks.listDevices.mockResolvedValue({ items: rows });
    let resolveFirst: (value: unknown) => void = () => {};
    apiMocks.pairDevice.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );
    await act(async () => {
      render(h(DevicesView, {}), host);
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Other devices"));
    await act(async () => {
      const other = [...host.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Other devices"),
      ) as HTMLButtonElement;
      other.click();
    });

    const openRepair = async (name: string) => {
      const card = [...host.querySelectorAll(".devices-card")].find((candidate) =>
        candidate.textContent?.includes(name),
      ) as HTMLElement;
      const trigger = card.querySelector(".source-action-trigger") as HTMLButtonElement;
      trigger.getBoundingClientRect = () =>
        ({ top: 100, bottom: 120, right: 400 }) as DOMRect;
      await act(async () => trigger.click());
      const repair = [...host.querySelectorAll('[role="menuitem"]')].find((item) =>
        item.textContent?.includes("Repair device"),
      ) as HTMLButtonElement;
      await act(async () => repair.click());
    };

    await openRepair("Fictional phone A");
    await act(async () => {
      (host.querySelector(".devices-pair-form") as HTMLFormElement).dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await act(async () => {
      const close = [...host.querySelectorAll("button")].find((button) =>
        button.textContent?.trim() === "Close",
      ) as HTMLButtonElement;
      close.click();
    });
    await openRepair("Fictional phone B");
    await act(async () => resolveFirst({ pairingCode: "ABCDEF0123", expiresAt: Date.now() + 60_000 }));

    expect(host.querySelector("#pair-modal-title")?.textContent).toContain("Fictional phone B");
    expect(host.querySelector(".devices-pair-result")).toBeNull();
  });

  test("keeps request and collector progress visible with collapsed cards", async () => {
    apiMocks.listDevices.mockResolvedValue({ items: [{
      id: "device_progress", name: "Progress collector", kind: "collector",
      pairedAt: Date.now(), lastSeenAt: Date.now(), online: true, capabilities: {},
    }] });
    apiMocks.getFleetDoctor.mockResolvedValue({ devices: [
      { deviceId: "device_progress", state: "not-run", online: true },
    ] });
    let finishRequest: (value: unknown) => void = () => {};
    apiMocks.requestFleetDoctor.mockImplementationOnce(() => new Promise((resolve) => {
      finishRequest = resolve;
    }));
    await act(async () => {
      render(h(DevicesView, {}), host);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Run health checks",
    ) as HTMLButtonElement;
    await act(async () => button.click());
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Requesting health checks");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(host.querySelector(".devices-card-health")).toBeNull();

    await act(async () => finishRequest({ devices: [
      { deviceId: "device_progress", state: "pending", online: true },
    ] }));
    expect(host.querySelector('[role="status"]')?.textContent).toContain("1 pending");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Expand a device");

    for (const [state, expected] of [["running", "1 running"], ["complete", "1 completed"], ["failed", "1 failed"]]) {
      apiMocks.getFleetDoctor.mockResolvedValue({ devices: [
        { deviceId: "device_progress", state, online: true },
      ] });
      await act(async () => document.dispatchEvent(new window.Event("visibilitychange")));
      await vi.waitFor(() => expect(host.querySelector('[role="status"]')?.textContent).toContain(expected));
      expect(host.querySelector(".devices-card-health")).toBeNull();
    }
  });

  test("a card action requests only that device", async () => {
    apiMocks.listDevices.mockResolvedValue({
      items: [
        {
          id: "device_collector",
          name: "Fictional collector",
          kind: "collector",
          pairedAt: Date.now(),
          lastSeenAt: Date.now(),
          online: true,
          capabilities: {},
        },
      ],
    });
    apiMocks.getFleetDoctor.mockResolvedValue({
      devices: [{ deviceId: "device_collector", state: "not-run" }],
    });

    await act(async () => {
      render(h(DevicesView, {}), host);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      (host.querySelector(".devices-card-toggle") as HTMLButtonElement).click();
    });
    await act(async () => {
      (host.querySelector(".devices-card-health button") as HTMLButtonElement).click();
    });

    expect(apiMocks.requestFleetDoctor).toHaveBeenCalledWith(["device_collector"]);
  });

  test("an overlapping status poll cannot erase a health action failure", async () => {
    await act(async () => {
      render(h(DevicesView, {}), host);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    let resolveStale: (value: { devices: never[] }) => void = () => {};
    apiMocks.getFleetDoctor.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    );
    await act(async () => {
      document.dispatchEvent(new window.Event("visibilitychange"));
    });

    apiMocks.requestFleetDoctor.mockRejectedValueOnce(new Error("Collector request failed"));
    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Run health checks",
    ) as HTMLButtonElement;
    await act(async () => button.click());
    expect(host.textContent).toContain("Collector request failed");

    await act(async () => {
      resolveStale({ devices: [] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain("Collector request failed");
  });

  test("an older status poll cannot regress a newer completed report", async () => {
    apiMocks.listDevices.mockResolvedValue({
      items: [
        {
          id: "device_sequence",
          name: "Sequence collector",
          kind: "collector",
          pairedAt: Date.now(),
          lastSeenAt: Date.now(),
          online: true,
          capabilities: {},
        },
      ],
    });
    apiMocks.getFleetDoctor.mockResolvedValueOnce({
      devices: [{ deviceId: "device_sequence", state: "not-run", online: true }],
    });
    await act(async () => {
      render(h(DevicesView, {}), host);
    });
    await vi.waitFor(() => expect(host.querySelector(".devices-card-toggle")).not.toBeNull());
    await act(async () => {
      (host.querySelector(".devices-card-toggle") as HTMLButtonElement).click();
    });

    let resolveOlder: (value: unknown) => void = () => {};
    apiMocks.getFleetDoctor
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      )
      .mockResolvedValueOnce({
        devices: [
          {
            deviceId: "device_sequence",
            state: "complete",
            online: true,
            completedAt: new Date().toISOString(),
            report: healthReport,
          },
        ],
      });

    await act(async () => document.dispatchEvent(new window.Event("visibilitychange")));
    await act(async () => document.dispatchEvent(new window.Event("visibilitychange")));
    await vi.waitFor(() => expect(host.textContent).toContain("Completed just now"));

    await act(async () => {
      resolveOlder({
        devices: [{ deviceId: "device_sequence", state: "pending", online: true }],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain("Completed just now");
    expect(host.textContent).not.toContain("waiting for the collector to begin");
  });
});

describe("phone notification transport", () => {
  test("uses plain-language labels for every stored transport", () => {
    expect(notificationTransportLabel({ pushTransport: "direct-apns" })).toBe("Direct APNs");
    expect(notificationTransportLabel({ pushTransport: "direct-fcm" })).toBe("Direct FCM");
    expect(notificationTransportLabel({ pushTransport: "relay" })).toBe("Relay");
    expect(notificationTransportLabel({ pushTransport: null })).toBe("Not configured");
  });
});

describe("device pairing kinds", () => {
  test("agent integrations are offered on any gateway", () => {
    expect(deviceKinds()).toContain("agent");
  });

  test("agent setup uses the selected advertised host without losing scheme or port", () => {
    expect(swapHostForUrl("https://gateway.example:17600", "198.51.100.7")).toBe(
      "https://198.51.100.7:17600",
    );
    expect(
      agentGatewayUrl(
        "https://gateway.example:17600",
        [
          { address: "192.0.2.42", label: "LAN" },
          { address: "gateway.tail.example", label: "Tailscale" },
        ],
        1,
      ),
    ).toBe("https://gateway.tail.example:17600");
  });

  test("presents separate OpenClaw and Hermes connect commands", () => {
    expect(agentConnectCommands("https://192.0.2.42:7600", "FICTION-2486")).toEqual([
      {
        label: "OpenClaw",
        command:
          "omnesis connect openclaw --gateway-url https://192.0.2.42:7600 --code FICTION-2486",
      },
      {
        label: "Hermes",
        command:
          "omnesis connect hermes --gateway-url https://192.0.2.42:7600 --code FICTION-2486",
      },
    ]);
  });
});

describe("browser extension pairing", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;
  let originalLocation: typeof globalThis.location | undefined;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    originalLocation = globalThis.location;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    Object.defineProperty(globalThis, "location", {
      value: { origin: "https://gateway.example.org:7600" },
      configurable: true,
      writable: true,
    });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
    apiMocks.listDevices.mockResolvedValue({ items: [] });
    apiMocks.getFleetDoctor.mockResolvedValue({ devices: [] });
    apiMocks.pairDevice.mockClear();
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
    Object.defineProperty(globalThis, "location", {
      value: originalLocation,
      configurable: true,
      writable: true,
    });
  });

  test("a pair deep link opens the modal with the browser kind preselected", async () => {
    apiMocks.pairDevice.mockResolvedValue({ pairingCode: "FICTION-2486", expiresAt: Date.now() + 60000 });
    await act(async () => {
      render(h(DevicesView, { pairKindRequest: "browser" }), host);
    });
    // The modal title is specific to the open modal — the page button reads
    // "Pair device", without "a new".
    expect(host.textContent).toContain("Pair a new device");
    // Minting from the deep-linked modal carries the preselected kind: the
    // select's value is unreadable under linkedom, so the minted request is
    // the observable proof of preselection.
    await act(async () => {
      (host.querySelector(".devices-pair-form") as HTMLFormElement).dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(apiMocks.pairDevice).toHaveBeenCalledWith({ kind: "browser" });
  });

  test("a phone's pairing code is carried by the QR, not shown on its own", async () => {
    apiMocks.pairDevice.mockResolvedValue({ pairingCode: "FICTION-2486", expiresAt: Date.now() + 60000 });
    apiMocks.getPairAddresses.mockResolvedValue({
      platform: "ios",
      addresses: [],
      recommendedUrl: null,
      awayFromHome: null,
    });
    for (const kind of ["ios", "browser"] as const) {
      await act(async () => {
        render(h(DevicesView, { pairKindRequest: kind }), host);
      });
      await act(async () => {
        (host.querySelector(".devices-pair-form") as HTMLFormElement).dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      const code = host.querySelector(".devices-pair-code");
      if (kind === "ios") {
        expect(code).toBeNull();
        expect(host.textContent).toMatch(/This code expires in \d+s\./);
      } else {
        expect(code?.textContent).toBe("FICTION-2486");
      }
      render(null, host);
    }
  });

  test("pairing an integration chooses its access level with the code, and says so", async () => {
    apiMocks.getAccessOverview.mockResolvedValue(accessOverview());
    apiMocks.pairDevice.mockResolvedValue({ pairingCode: "FICTION-2486", expiresAt: Date.now() + 60000 });
    await act(async () => {
      render(h(DevicesView, { pairKindRequest: "integration" }), host);
    });
    await vi.waitFor(() => {
      expect(host.querySelector("#pair-level")).not.toBeNull();
    });
    const nameInput = host.querySelector("#pair-name") as HTMLInputElement;
    Object.defineProperty(nameInput, "value", { value: "Kitchen display", configurable: true });
    await act(async () => {
      nameInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const levelPicker = host.querySelector("#pair-level") as HTMLSelectElement;
    expect([...levelPicker.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "Choose later — questions refused until then",
      "Assistant",
      "Voice answers",
    ]);
    Object.defineProperty(levelPicker, "value", { value: "level-voice", configurable: true });
    await act(async () => {
      levelPicker.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await act(async () => {
      (host.querySelector(".devices-pair-form") as HTMLFormElement).dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(apiMocks.pairDevice).toHaveBeenCalledWith({
      kind: "integration",
      name: "Kitchen display",
      accessLevelId: "level-voice",
    });
    expect(host.textContent).toContain("omnesis devices redeem FICTION-2486");
    expect(host.textContent).toContain("Its answers use the access level “Voice answers”.");
    apiMocks.getAccessOverview.mockResolvedValue({ levels: [] });
  });

  test("an integration paired without a level is told its questions are refused until one is chosen", async () => {
    apiMocks.getAccessOverview.mockResolvedValue(accessOverview());
    apiMocks.pairDevice.mockResolvedValue({ pairingCode: "FICTION-2487", expiresAt: Date.now() + 60000 });
    await act(async () => {
      render(h(DevicesView, { pairKindRequest: "integration" }), host);
    });
    await act(async () => {
      (host.querySelector(".devices-pair-form") as HTMLFormElement).dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(apiMocks.pairDevice).toHaveBeenCalledWith({ kind: "integration" });
    expect(host.textContent).toContain("Its questions are refused until you choose its access level");
    apiMocks.getAccessOverview.mockResolvedValue({ levels: [] });
  });

  test("repairing an integration says it comes back on the level it kept", async () => {
    apiMocks.getAccessOverview.mockResolvedValue(accessOverview());
    apiMocks.listDevices.mockResolvedValue({
      items: [{
        id: "device_kd",
        name: "Kitchen display",
        kind: "integration",
        online: false,
        pairedAt: 1,
        lastSeenAt: null,
        revokedAt: 5,
        accessLevelId: "level-voice",
        capabilities: {},
      }],
    });
    apiMocks.pairDevice.mockResolvedValueOnce({ pairingCode: "ABCDEF0124", expiresAt: Date.now() + 60_000 });
    await act(async () => {
      render(h(DevicesView, {}), host);
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Other devices"));
    await act(async () => {
      const other = [...host.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Other devices"),
      ) as HTMLButtonElement;
      other.click();
    });
    const trigger = host.querySelector(".devices-card .source-action-trigger") as HTMLButtonElement;
    trigger.getBoundingClientRect = () => ({ top: 100, bottom: 120, right: 400 }) as DOMRect;
    await act(async () => trigger.click());
    const repair = [...host.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.includes("Repair device"),
    ) as HTMLButtonElement;
    await act(async () => repair.click());
    expect(host.querySelector(".devices-modal")?.textContent).toContain(
      "Re-pairing keeps its device identity and its access level.",
    );
    await act(async () => {
      (host.querySelector(".devices-pair-form") as HTMLFormElement).dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(apiMocks.pairDevice).toHaveBeenCalledWith({ kind: "integration", repairDeviceId: "device_kd" });
    expect(host.textContent).toContain("omnesis devices redeem ABCDEF0124");
    expect(host.textContent).toContain("It comes back on the access level “Voice answers”.");
    apiMocks.getAccessOverview.mockResolvedValue({ levels: [] });
  });

  test("a refused pairing is explained inside the modal, and stays until the request changes", async () => {
    apiMocks.getAccessOverview.mockResolvedValue(accessOverview());
    apiMocks.pairDevice.mockRejectedValue(
      Object.assign(new Error("POST /admin/devices/pair: 400"), {
        status: 400,
        serverMessage: "name the integration when pairing it",
      }),
    );
    await act(async () => {
      render(h(DevicesView, { pairKindRequest: "integration" }), host);
    });
    await act(async () => {
      (host.querySelector(".devices-pair-form") as HTMLFormElement).dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(host.querySelector(".devices-modal [role=alert]")?.textContent).toBe(
      "Name the integration when pairing it.",
    );
    const nameInput = host.querySelector("#pair-name") as HTMLInputElement;
    Object.defineProperty(nameInput, "value", { value: "Kitchen display", configurable: true });
    await act(async () => {
      nameInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    expect(host.querySelector(".devices-modal [role=alert]")).toBeNull();
    apiMocks.pairDevice.mockReset();
    apiMocks.getAccessOverview.mockResolvedValue({ levels: [] });
  });

  test("only pairable kinds survive deep-link validation", () => {
    expect(resolvePairKindRequest("browser")).toBe("browser");
    expect(resolvePairKindRequest("cli")).toBe("cli");
    expect(resolvePairKindRequest("toaster")).toBe(null);
    expect(resolvePairKindRequest(null)).toBe(null);
    expect(resolvePairKindRequest(undefined)).toBe(null);
  });

  test("a pair request arriving without a remount still opens the modal", async () => {
    await act(async () => {
      render(h(DevicesView, { pairKindRequest: null }), host);
    });
    expect(host.textContent).not.toContain("Pair a new device");
    // Same mounted tree, new props — e.g. Back/Forward onto a ?pair= URL.
    await act(async () => {
      render(h(DevicesView, { pairKindRequest: "browser" }), host);
    });
    expect(host.textContent).toContain("Pair a new device");
  });

  test("an unknown pair kind leaves the modal closed", async () => {
    await act(async () => {
      render(h(DevicesView, { pairKindRequest: "toaster" }), host);
    });
    expect(host.textContent).not.toContain("Pair a new device");
  });

  test("no pair request leaves the modal closed", async () => {
    await act(async () => {
      render(h(DevicesView, {}), host);
    });
    expect(host.textContent).not.toContain("Pair a new device");
  });

  test("browser instructions link to the Chrome Web Store", async () => {
    await act(async () => {
      render(
        h(PairInstructions, {
          pairResult: { kind: "browser", pairingCode: "FICTION-2486" },
          identities: [],
          selectedHostIdx: 0,
          setSelectedHostIdx: () => {},
        }),
        host,
      );
    });
    const link = host.querySelector(
      'a[href^="https://chromewebstore.google.com/"]',
    ) as HTMLAnchorElement;
    expect(link?.textContent).toContain("Chrome Web Store");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  describe("phone pairing", () => {
    const local = {
      gatewayUrl: "https://192.0.2.42:7600",
      host: "192.0.2.42",
      label: "Local network",
      usable: true,
      reach: "local-network",
      systemTrust: false,
      summary: "Works only while the phone is on the same network as the gateway, such as your home Wi-Fi.",
    };
    const trustedName = {
      gatewayUrl: "https://gateway.tail-example.ts.net:7600",
      host: "gateway.tail-example.ts.net",
      label: "Tailscale name",
      usable: true,
      reach: "tailnet",
      systemTrust: true,
      summary: "Works at home and away, as long as Tailscale is connected on the phone.",
    };
    const refusedIp = {
      gatewayUrl: "https://100.101.102.103:7600",
      host: "100.101.102.103",
      label: "Tailscale IP",
      usable: false,
      reason: "iPhones refuse the gateway's own certificate at a Tailscale IP address.",
    };

    beforeEach(() => {
      apiMocks.getPairAddresses.mockReset();
      apiMocks.buildPairQrPayload.mockReset();
    });

    /** Let the address plan, then the QR payload, resolve and render. */
    async function settle() {
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          await Promise.resolve();
        });
      }
    }

    async function renderPhone(kind: "ios" | "android", plan: unknown) {
      apiMocks.getPairAddresses.mockResolvedValue(plan);
      apiMocks.buildPairQrPayload.mockImplementation(async ({ gatewayUrl }: { gatewayUrl: string }) => ({
        qrPayload: `fictional-qr-payload for ${gatewayUrl}`,
      }));
      await act(async () => {
        render(
          h(PairInstructions, {
            pairResult: { kind, pairingCode: "FICTION-2486" },
            identities: [],
            selectedHostIdx: 0,
            setSelectedHostIdx: () => {},
          }),
          host,
        );
      });
      await settle();
    }

    test("opens on the recommended address and says where it works", async () => {
      await renderPhone("ios", {
        platform: "ios",
        addresses: [trustedName, local, refusedIp],
        recommendedUrl: trustedName.gatewayUrl,
        awayFromHome: null,
      });
      expect(apiMocks.getPairAddresses).toHaveBeenCalledWith({ pairingCode: "FICTION-2486" });
      expect(apiMocks.buildPairQrPayload).toHaveBeenLastCalledWith({
        pairingCode: "FICTION-2486",
        gatewayUrl: trustedName.gatewayUrl,
      });
      expect(host.textContent).toContain("Scan with the Omnesis app on your iPhone");
      expect(host.querySelector(".devices-phone-reach")?.getAttribute("data-reach")).toBe("tailnet");
      expect(host.querySelector(".devices-phone-reach-summary")?.textContent).toBe(trustedName.summary);
      expect(host.querySelector(".devices-phone-away")).toBeNull();
    });

    test("names a refused address with its reason instead of offering it", async () => {
      await renderPhone("ios", {
        platform: "ios",
        addresses: [trustedName, local, refusedIp],
        recommendedUrl: trustedName.gatewayUrl,
        awayFromHome: null,
      });
      const choices = [...host.querySelectorAll('input[name="pair-address"]')].map(
        (input) => (input as HTMLInputElement).value,
      );
      expect(choices).toEqual([trustedName.gatewayUrl, local.gatewayUrl]);
      const refused = host.querySelector(".devices-phone-refused")?.textContent ?? "";
      expect(refused).toContain("Not offered for an iPhone");
      expect(refused).toContain("100.101.102.103");
      expect(refused).toContain(refusedIp.reason);
    });

    test("a phone that can't scan gets the JSON, and the typed code only where manual entry works", async () => {
      await renderPhone("ios", {
        platform: "ios",
        addresses: [trustedName, local],
        recommendedUrl: trustedName.gatewayUrl,
        awayFromHome: null,
      });
      const raw = () => host.querySelector(".devices-phone-qr-raw")?.textContent?.replace(/\s+/g, " ") ?? "";
      expect(raw()).toContain("Can't scan the code?");
      expect(raw()).toContain(`fictional-qr-payload for ${trustedName.gatewayUrl}`);
      expect(raw()).toContain(`type the gateway URL ${trustedName.gatewayUrl} and the pairing code FICTION-2486`);

      const localChoice = host.querySelector(`input[value="${local.gatewayUrl}"]`) as HTMLInputElement;
      await act(async () => {
        localChoice.dispatchEvent(new window.Event("change"));
      });
      await settle();
      // A pinned address needs the fingerprint the JSON carries; typed entry can't supply it.
      expect(raw()).toContain(`fictional-qr-payload for ${local.gatewayUrl}`);
      expect(raw()).not.toContain("Manual entry");
    });

    test("marks the recommended address among the choices", async () => {
      await renderPhone("ios", {
        platform: "ios",
        addresses: [trustedName, local],
        recommendedUrl: trustedName.gatewayUrl,
        awayFromHome: null,
      });
      const names = [...host.querySelectorAll(".devices-phone-choice-name")].map((n) =>
        n.textContent?.replace(/\s+/g, " ").trim(),
      );
      expect(names).toEqual([
        "Tailscale name · gateway.tail-example.ts.net (recommended)",
        "Local network · 192.0.2.42",
      ]);
    });

    test("an address whose QR can't be made shows no stale code", async () => {
      await renderPhone("ios", {
        platform: "ios",
        addresses: [trustedName, local],
        recommendedUrl: trustedName.gatewayUrl,
        awayFromHome: null,
      });
      expect(host.querySelector("canvas")?.getAttribute("aria-label")).toBe(
        "Pairing QR code for gateway.tail-example.ts.net",
      );
      apiMocks.buildPairQrPayload.mockRejectedValue(
        Object.assign(new Error("400"), { serverMessage: "This pairing code has expired." }),
      );
      const localChoice = host.querySelector(
        `input[value="${local.gatewayUrl}"]`,
      ) as HTMLInputElement;
      await act(async () => {
        localChoice.dispatchEvent(new window.Event("change"));
      });
      await settle();
      expect(host.querySelector("canvas")).toBeNull();
      expect(host.querySelector(".devices-phone-qr-raw")).toBeNull();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("This pairing code has expired.");
    });

    test("switching address re-encodes the QR for the chosen one", async () => {
      await renderPhone("ios", {
        platform: "ios",
        addresses: [trustedName, local],
        recommendedUrl: trustedName.gatewayUrl,
        awayFromHome: null,
      });
      const localChoice = host.querySelector(
        `input[value="${local.gatewayUrl}"]`,
      ) as HTMLInputElement;
      await act(async () => {
        localChoice.dispatchEvent(new window.Event("change"));
      });
      expect(apiMocks.buildPairQrPayload).toHaveBeenLastCalledWith({
        pairingCode: "FICTION-2486",
        gatewayUrl: local.gatewayUrl,
      });
      expect(host.querySelector(".devices-phone-reach")?.getAttribute("data-reach")).toBe(
        "local-network",
      );
    });

    test("an iPhone limited to the home network gets the away-from-home steps", async () => {
      await renderPhone("ios", {
        platform: "ios",
        addresses: [local, refusedIp],
        recommendedUrl: local.gatewayUrl,
        awayFromHome: { onTailnet: true, tailscaleName: "gateway.tail-example.ts.net" },
      });
      const away = host.querySelector(".devices-phone-away")?.textContent ?? "";
      expect(away).toContain("To use this iPhone away from home");
      expect(away).toContain("omnesis tls provision");
      expect(away.replace(/\s+/g, " ")).toContain("for gateway.tail-example.ts.net from Tailscale.");
      expect(away).not.toMatch(/install tailscale/i);
      expect(host.querySelector('a[href="https://omnesis.dev/docs/setup#away-from-home"]')).not.toBeNull();
      expect(host.querySelector("summary")?.textContent).toBe("Why other addresses aren't offered");
    });

    test("an Android phone off a tailnet is told to install Tailscale, not to get a certificate", async () => {
      await renderPhone("android", {
        platform: "android",
        addresses: [local],
        recommendedUrl: local.gatewayUrl,
        awayFromHome: { onTailnet: false, tailscaleName: null },
      });
      const away = host.querySelector(".devices-phone-away")?.textContent ?? "";
      expect(away).toContain("To use this Android phone away from home");
      expect(away).toMatch(/install tailscale/i);
      expect(away).not.toContain("omnesis tls provision");
      expect(host.querySelector(".devices-phone-alternatives")).toBeNull();
    });

    test("with no usable address there is no QR code, only the reasons and the way forward", async () => {
      await renderPhone("ios", {
        platform: "ios",
        addresses: [refusedIp],
        recommendedUrl: null,
        awayFromHome: { onTailnet: true, tailscaleName: null },
      });
      expect(host.querySelector("canvas")).toBeNull();
      expect(apiMocks.buildPairQrPayload).not.toHaveBeenCalled();
      expect(host.textContent).toContain("there is no QR code to scan");
      expect(host.textContent).toContain(refusedIp.reason);
      const away = host.querySelector(".devices-phone-away")?.textContent ?? "";
      expect(away).toContain("Turn on MagicDNS");
      expect(away).toContain("omnesis tls provision");
      expect(away).not.toMatch(/install tailscale/i);
    });

    test("a gateway error is shown in plain words", async () => {
      apiMocks.getPairAddresses.mockRejectedValue(
        Object.assign(new Error("400"), {
          serverMessage: "This pairing code has expired or was already used. Create a new one.",
        }),
      );
      await act(async () => {
        render(
          h(PairInstructions, {
            pairResult: { kind: "ios", pairingCode: "FICTION-2486" },
            identities: [],
            selectedHostIdx: 0,
            setSelectedHostIdx: () => {},
          }),
          host,
        );
      });
      await settle();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain("expired or was already used");
    });
  });
});

describe("device revocation impact", () => {
  let host: HTMLElement;

  beforeEach(() => {
    const { document, window } = parseHTML("<div id='root'></div>");
    Object.assign(globalThis, { document, window });
    host = document.getElementById("root") as unknown as HTMLElement;
  });

  afterEach(() => render(null, host));

  test("names each connection the revocation stops, with its sign-in when it is named differently", async () => {
    await act(async () => {
      render(
        h(DeviceRevocationImpact, {
          device: {
            kind: "agent",
            revocationImpact: {
              fingerprint: "a".repeat(64),
              corpusCredentials: [
                {
                  credentialLabel: "Lab runtime",
                  principalName: "Fictional assistant",
                },
                {
                  credentialLabel: "Studio helper",
                  principalName: "Studio helper",
                },
              ],
              corpusAccess: [],
            },
          },
        }),
        host,
      );
    });

    const rows = [...host.querySelectorAll(".devices-revocation-grant")];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [...row.children].map((child) => child.textContent))).toEqual([
      ["Fictional assistant", "Lab runtime"],
      ["Studio helper"],
    ]);
    expect(host.textContent).toContain("stops the connections signed in from this agent installation");
    expect(host.textContent).toContain("Connections signed in from other installations are not affected.");
    expect(host.textContent).not.toMatch(/grant|credential|principal/i);
  });

  test("does not list connections when nothing is signed in from the agent", async () => {
    await act(async () => {
      render(
        h(DeviceRevocationImpact, {
          device: {
            kind: "agent",
            revocationImpact: {
              fingerprint: "b".repeat(64),
              corpusCredentials: [],
              corpusAccess: [],
            },
          },
        }),
        host,
      );
    });
    expect(host.querySelectorAll(".devices-revocation-grant")).toHaveLength(0);
    expect(host.textContent).not.toContain("other installations");
  });

  test("never attributes delegated corpus authority to a collector", async () => {
    await act(async () => {
      render(
        h(DeviceRevocationImpact, {
          device: {
            kind: "collector",
            revocationImpact: {
              corpusCredentials: [
                { principalName: "Fictional assistant", credentialLabel: "Lab runtime" },
              ],
              corpusAccess: [],
            },
          },
        }),
        host,
      );
    });
    expect(host.querySelectorAll(".devices-revocation-grant")).toHaveLength(0);
    expect(host.textContent).not.toContain("Fictional assistant");
    expect(host.textContent).not.toContain("other installations");
  });

  test("renders the live-authority fallback from a cached older response", async () => {
    await act(async () => {
      render(
        h(DeviceRevocationImpact, {
          device: {
            kind: "agent",
            revocationImpact: {
              corpusAccess: [
                { principalName: "Fictional assistant", credentialLabel: "Lab runtime" },
              ],
            },
          },
        }),
        host,
      );
    });
    expect(host.querySelector(".devices-revocation-grant")?.textContent).toContain(
      "Fictional assistant",
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "cannot report every connection signed in from this agent",
    );
  });

  test("requires a valid fingerprint before treating a preview as complete", () => {
    expect(
      deviceCorpusCredentialImpact({
        kind: "agent",
        revocationImpact: { corpusCredentials: [], corpusAccess: [] },
      }),
    ).toEqual({ credentials: [], complete: false });
  });
});

describe("the version chip", () => {
  /**
   * The chip is only a rendering of the gateway's verdict. What matters is
   * which verdicts are allowed to look alarming: only `unsupported`, since a
   * lagging app build is the normal consequence of a store release trailing
   * the tag it was cut from.
   */
  const chipClass = (device: Record<string, unknown>): string | null => {
    const node = versionChip(device) as { props?: { class?: string } } | null;
    return node?.props?.class ?? null;
  };

  test("shows nothing for a device that never reported a version", () => {
    expect(versionChip({ versionState: "unknown", version: null })).toBeNull();
    // Nothing to say about a device that is fine and reported no number.
    expect(versionChip({ versionState: "current" })).toBeNull();
    expect(versionChip({ versionState: "behind" })).toBeNull();
  });

  test("still flags an unsupported device that reported no version", () => {
    // Reachable: a pre-ledger build reports no version, and a later protocol
    // bump strands it. Silence here would hide the one row that needs action.
    const node = versionChip({ versionState: "unsupported", version: null }) as {
      props?: { class?: string; children?: string };
    };
    expect(node?.props?.class).toContain("unsupported");
    expect(node?.props?.children).toBe("unsupported");
  });

  test("marks only an unsupported device", () => {
    expect(chipClass({ versionState: "current", version: "1.4.0" })).toContain("current");
    expect(chipClass({ versionState: "current", version: "1.4.0" })).not.toContain("unsupported");
    expect(chipClass({ versionState: "behind", version: "1.3.0" })).toContain("behind");
    expect(chipClass({ versionState: "unsupported", version: "0.9.0" })).toContain("unsupported");
  });

  test("spells out why an unsupported device is flagged", () => {
    const node = versionChip({ versionState: "unsupported", version: "0.9.0" }) as {
      props?: { children?: string; title?: string };
    };
    expect(node.props?.children).toContain("0.9.0");
    expect(node.props?.children).toContain("unsupported");
    expect(node.props?.title).toMatch(/update/i);
  });
});

describe("which devices are offered an update", () => {
  const device = (id: string, updateDisposition: unknown): unknown => ({
    id,
    name: id,
    kind: "collector",
    version: "0.4.0",
    updateDisposition,
  });

  test("only the devices the gateway itself says it would command", () => {
    // The refusals behind the disposition are safety rules, not UI hints: a
    // phone updates through its store, and a device of unknown or unsupported
    // version is never commanded at all.
    const devices = [
      device("behind", { kind: "update" }),
      device("current", { kind: "current" }),
      device("phone", { kind: "refused", code: "store-managed", reason: "Update the app." }),
      device("unknown", { kind: "refused", code: "version-unknown", reason: "Update by hand." }),
      device("no-disposition", undefined),
    ];
    expect(updatableDevices(devices, "0.5.0").map((d) => (d as { id: string }).id)).toEqual([
      "behind",
    ]);
  });

  test("nothing is offered before the target version is known", () => {
    // The prompt names the version it moves to; without one there is nothing
    // honest to ask.
    expect(updatableDevices([device("behind", { kind: "update" })], null)).toEqual([]);
  });
});

describe("the update chip", () => {
  const chipOf = (device: unknown): string | null => {
    const node = updateChip(device) as { props?: { children?: unknown } } | null;
    return node ? String(node.props?.children) : null;
  };

  test("says nothing when no update is outstanding", () => {
    expect(chipOf({ updateState: null })).toBeNull();
    // `installed` is still owed a reconnect, but the version chip beside it
    // is what reports that; two chips saying the same thing is noise.
    expect(chipOf({ updateState: "installed", desiredVersion: "0.5.0" })).toBeNull();
  });

  test("names the version a parked or running update is heading for", () => {
    expect(chipOf({ updateState: "pending", desiredVersion: "0.5.0" })).toContain("0.5.0");
    expect(chipOf({ updateState: "dispatched", desiredVersion: "0.5.0" })).toContain("updating");
  });

  test("does not expose a CLI-only exact commit target", () => {
    const target = `commit:${"a".repeat(40)}`;
    expect(chipOf({ updateState: "pending", desiredVersion: target })).toBe("update pending");
    expect(chipOf({ updateState: "dispatched", desiredVersion: target })).toBe("updating");
  });

  test("the states that need the operator say what they need", () => {
    expect(chipOf({ updateState: "restart-pending" })).toContain("restart");
    expect(chipOf({ updateState: "failed" })).toContain("failed");
    expect(chipOf({ updateState: "unsupported" })).toContain("update on its machine");
    expect(chipOf({ updateState: "unsupported" })).not.toContain("failed");
  });

  test("an unsupported chip carries the gateway's refusal, which names the commands", () => {
    const reason =
      "This build cannot be updated remotely: it does not accept update commands. On that machine run `omnesis update`.";
    const node = updateChip({
      updateState: "unsupported",
      updateDetail: "This build does not accept update commands.",
      updateDisposition: { kind: "refused", code: "command-unsupported", reason },
    }) as { props?: { title?: string } } | null;
    expect(node?.props?.title).toBe(reason);
  });
});

describe("the collector pairing instructions", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;
  let originalLocation: typeof globalThis.location | undefined;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    originalLocation = globalThis.location;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    Object.defineProperty(globalThis, "location", {
      value: { origin: "https://gateway.example.org:7600" },
      configurable: true,
      writable: true,
    });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
    Object.defineProperty(globalThis, "location", {
      value: originalLocation,
      configurable: true,
      writable: true,
    });
  });

  // The portal is where an operator mints a collector code, so it is also
  // where they decide what to run on the other machine. Offering only the
  // three-command sequence is what sends a reader back to a bare installer,
  // which installs a second gateway.
  test("lead with the one-line install and keep the manual redeem below it", async () => {
    await act(async () => {
      render(
        h(PairInstructions, {
          pairResult: { kind: "collector", pairingCode: "FICTION-2486" },
          identities: [],
          selectedHostIdx: 0,
          setSelectedHostIdx: () => {},
        }),
        host,
      );
    });
    const text = host.textContent ?? "";
    expect(text).toContain(
      "curl -fsSL https://omnesis.dev/install.sh | sh -s -- --collector " +
        "--gateway-url https://gateway.example.org:7600",
    );
    expect(text).toContain("--trust-fingerprint");
    expect(text).toContain(
      "omnesis pair FICTION-2486 --gateway-url https://gateway.example.org:7600 " +
        "--save ~/.config/omnesis/collector-token",
    );
    // The claim that made the code look optional: it is not, for a machine
    // that is not the gateway host.
    expect(text).not.toContain("pairs itself on first run");
  });
});

describe("expanded device cards", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
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

  test("passes the whole device into the revoke confirmation", async () => {
    const device = {
      id: "device-agent",
      name: "Studio agent",
      kind: "agent",
      pairedAt: 1,
      lastSeenAt: 2,
      online: true,
      capabilities: {},
      revocationImpact: {
        fingerprint: "c".repeat(64),
        corpusCredentials: [
          {
            credentialLabel: "Lab runtime",
            principalName: "Fictional assistant",
          },
        ],
        corpusAccess: [],
      },
    };
    const onRevokeDevice = vi.fn();
    const win = globalThis.window as unknown as { innerHeight: number; innerWidth: number };
    win.innerHeight = 800;
    win.innerWidth = 1200;
    await act(async () => {
      render(
        h(DeviceCard, {
          device,
          isThis: false,
          tokens: [],
          expanded: false,
          onToggle: vi.fn(),
          onRevokeDevice,
          onForgetDevice: vi.fn(),
          onRevokeToken: vi.fn(),
        }),
        host,
      );
    });
    const trigger = host.querySelector(".source-action-trigger") as HTMLElement;
    trigger.getBoundingClientRect = () =>
      ({ top: 100, bottom: 120, right: 400 }) as DOMRect;
    await act(async () => {
      (trigger as unknown as { click(): void }).click();
    });
    const revoke = [...host.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.includes("Revoke device"),
    ) as HTMLElement;
    await act(async () => {
      (revoke as unknown as { click(): void }).click();
    });

    expect(onRevokeDevice).toHaveBeenCalledWith(device);
  });

  // A revoked device that still hosts sources is the most actionable card in
  // the list: it earns a distinct badge, keeps full opacity, and carries the
  // exact command that brings it back.
  test("a needs-pairing card names the repair command and is not dimmed", async () => {
    await act(async () => {
      render(
        h(DeviceCard, {
          device: {
            id: "device_dormant",
            name: "studio-collector",
            kind: "collector",
            pairedAt: 1,
            lastSeenAt: null,
            online: false,
            revokedAt: 2,
            needsPairing: true,
            capabilities: {},
          },
          isThis: false,
          tokens: [],
          expanded: true,
          onToggle: vi.fn(),
          onRevokeDevice: vi.fn(),
          onForgetDevice: vi.fn(),
          onRevokeToken: vi.fn(),
        }),
        host,
      );
    });
    const card = host.querySelector(".devices-card") as HTMLElement;
    expect(card.className).toContain("revoked");
    expect(card.className).toContain("needs-pairing");
    expect(host.querySelector(".devices-card-badge.needs-pairing")?.textContent).toBe(
      "Needs re-pairing",
    );
    expect(host.querySelector(".devices-card-repair")?.textContent).toContain(
      "omnesis devices repair studio-collector",
    );
  });

  /**
   * The card offers the action only when it is given a handler; which cards
   * get one is `DevicesView`'s decision, driven by the gateway's own
   * disposition. Both halves matter, so both are covered — this one and
   * "offers no update action for a device the gateway will not command"
   * below.
   */
  test("the actions menu offers the update action only when it is given a handler", async () => {
    const device = {
      id: "device_behind",
      name: "studio-collector",
      kind: "collector",
      version: "0.4.0",
      versionState: "behind",
      pairedAt: 1,
      lastSeenAt: 2,
      online: true,
      revokedAt: null,
      capabilities: {},
    };
    // The menu positions itself against the viewport before it opens, and
    // linkedom models neither measurement; supply the two it reads.
    const win = globalThis.window as unknown as { innerHeight: number; innerWidth: number };
    win.innerHeight = 800;
    win.innerWidth = 1200;
    const renderCard = async (onUpdateDevice: (() => void) | null): Promise<void> => {
      await act(async () => {
        render(
          h(DeviceCard, {
            device,
            isThis: false,
            tokens: [],
            expanded: false,
            onToggle: vi.fn(),
            onRevokeDevice: vi.fn(),
            onForgetDevice: vi.fn(),
            onUpdateDevice,
            onRevokeToken: vi.fn(),
          }),
          host,
        );
      });
      const trigger = host.querySelector(".source-action-trigger") as HTMLElement;
      trigger.getBoundingClientRect = () =>
        ({ top: 100, bottom: 120, right: 400 }) as DOMRect;
      await act(async () => {
        (trigger as unknown as { click(): void }).click();
      });
    };

    await renderCard(vi.fn());
    const items = [...host.querySelectorAll(".source-action-item")].map((el) => el.textContent);
    expect(items.some((text) => text?.includes("Update device"))).toBe(true);

    render(null, host);
    await renderCard(null);
    const withoutUpdate = [...host.querySelectorAll(".source-action-item")].map(
      (el) => el.textContent,
    );
    expect(withoutUpdate.some((text) => text?.includes("Update device"))).toBe(false);
    expect(withoutUpdate.some((text) => text?.includes("Revoke device"))).toBe(true);
  });

  test("a revoked card with nothing to bring back stays a plain revoked card", async () => {
    await act(async () => {
      render(
        h(DeviceCard, {
          device: {
            id: "device_retired",
            name: "retired-collector",
            kind: "collector",
            pairedAt: 1,
            lastSeenAt: null,
            online: false,
            revokedAt: 2,
            capabilities: {},
          },
          isThis: false,
          tokens: [],
          expanded: true,
          onToggle: vi.fn(),
          onRevokeDevice: vi.fn(),
          onForgetDevice: vi.fn(),
          onRevokeToken: vi.fn(),
        }),
        host,
      );
    });
    const card = host.querySelector(".devices-card") as HTMLElement;
    expect(card.className).not.toContain("needs-pairing");
    expect(host.querySelector(".devices-card-badge.revoked")?.textContent).toBe("Revoked");
    expect(host.querySelector(".devices-card-repair")).toBeNull();
  });

  test("credentials list points at the CLI and the menu offers repair and revoke", async () => {
    await act(async () => {
      render(
        h(DeviceCard, {
          device: {
            id: "device_collector",
            name: "Fictional collector",
            kind: "collector",
            pairedAt: 1,
            lastSeenAt: null,
            online: false,
            capabilities: {},
          },
          isThis: false,
          tokens: [{ id: "tok_1", deviceId: "device_collector", scopes: ["read", "write:*"], createdAt: 1 }],
          expanded: true,
          onToggle: vi.fn(),
          onRevokeDevice: vi.fn(),
          onRevokeToken: vi.fn(),
        }),
        host,
      );
    });
    const hint = host.querySelector(".devices-card-creds-hint");
    expect(hint?.textContent).toContain("omnesis tokens create --device <device> --scopes");
    expect(host.querySelectorAll(".devices-token-row, .devices-scope").length).toBeGreaterThan(0);

    await act(async () => {
      (host.querySelector(".devices-card-menu button") as HTMLButtonElement).click();
    });
    const items = Array.from(host.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent?.trim());
    expect(items).toEqual(["Repair device", "Revoke device"]);
  });

  test("repair is bound to a non-portal device and excluded from portal sessions", async () => {
    const onRepairDevice = vi.fn();
    const base = {
      id: "device_phone",
      name: "Fictional phone",
      kind: "android",
      pairedAt: 1,
      lastSeenAt: null,
      online: false,
      capabilities: {},
    };
    const props = {
      isThis: false,
      tokens: [],
      expanded: false,
      onToggle: vi.fn(),
      onRepairDevice,
      onRevokeDevice: vi.fn(),
      onForgetDevice: vi.fn(),
      onRevokeToken: vi.fn(),
    };
    await act(async () => render(h(DeviceCard, { ...props, device: base }), host));
    await act(async () => {
      (host.querySelector(".devices-card-menu button") as HTMLButtonElement).click();
    });
    const repair = [...host.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent?.includes("Repair device"),
    ) as HTMLButtonElement;
    await act(async () => repair.click());
    expect(onRepairDevice).toHaveBeenCalledWith(base);

    await act(async () =>
      render(h(DeviceCard, { ...props, device: { ...base, kind: "portal" } }), host),
    );
    await act(async () => {
      (host.querySelector(".devices-card-menu button") as HTMLButtonElement).click();
    });
    expect(host.textContent).not.toContain("Repair device");
  });

  test("renders an expanded agent card", () => {
    const kind = "agent";
    expect(() =>
      DeviceCard({
        device: {
          id: `device_${kind}`,
          name: "Fictional agent",
          kind,
          pairedAt: 1,
          lastSeenAt: null,
          online: false,
          capabilities: { agentIntegration: { harness: "openclaw" } },
        },
        isThis: false,
        tokens: [],
        expanded: true,
        onToggle: vi.fn(),
        onRevokeDevice: vi.fn(),
        onRevokeToken: vi.fn(),
      }),
    ).not.toThrow();
  });

  test("badges an agent whose corpus access has lapsed", async () => {
    // A managed harness can be paired, online and ingesting transcripts while
    // being unable to read the corpus — that authority is a separate grant
    // whose ticket expires from disuse. Nothing else on the card says so.
    const device = {
      id: "device_agent",
      name: "Fictional agent",
      kind: "agent",
      pairedAt: 1,
      lastSeenAt: null,
      online: true,
      capabilities: { agentIntegration: { harness: "openclaw" } },
      agentAuthorization: {
        status: "needs-reauthorization",
        remedy: "omnesis connect openclaw --refresh",
      },
    };
    const props = {
      isThis: false,
      tokens: [],
      expanded: false,
      onToggle: vi.fn(),
      onRevokeDevice: vi.fn(),
      onForgetDevice: vi.fn(),
      onRevokeToken: vi.fn(),
    };

    await act(async () => {
      render(h(DeviceCard, { ...props, device }), host);
    });
    expect(host.textContent).toContain("Needs re-authorization");

    await act(async () => {
      render(
        h(DeviceCard, { ...props, device: { ...device, agentAuthorization: { status: "authorized" } } }),
        host,
      );
    });
    expect(host.textContent).not.toContain("Needs re-authorization");
  });

  test("shows a phone's transport and lets the operator withdraw relay consent", async () => {
    const onWithdrawRelayConsent = vi.fn();
    const phone = {
      id: "device_phone",
      name: "Fictional phone",
      kind: "android",
      pairedAt: 1,
      lastSeenAt: 2,
      online: false,
      revokedAt: null,
      capabilities: { pushAppId: "dev.omnesis.android" },
      pushTransport: "relay",
      relayConsent: { appId: "dev.omnesis.android", grantedAt: 3 },
      relayCredential: "opaque-secret-must-not-render",
    };
    await act(async () => {
      render(h(DeviceCard, {
        device: phone,
        isThis: false,
        tokens: [],
        expanded: true,
        onToggle: vi.fn(),
        onRevokeDevice: vi.fn(),
        onForgetDevice: vi.fn(),
        onWithdrawRelayConsent,
        onRevokeToken: vi.fn(),
      }), host);
    });

    expect(host.textContent).toContain("Notifications: Relay");
    expect(host.textContent).toContain("Relay allowed");
    expect(host.textContent).toContain("dev.omnesis.android");
    await act(async () => {
      (host.querySelector(".devices-relay-consent button") as HTMLButtonElement).click();
    });
    expect(onWithdrawRelayConsent).toHaveBeenCalledWith(phone);
    expect(host.textContent).not.toContain("opaque-secret-must-not-render");
  });
});

const DEFAULT_POLICY_ID = "00000000-0000-4000-8000-000000000001";

/** An access overview with two levels that can answer and one that cannot. */
function accessOverview() {
  const answer = (sources, release) => ({ capability: "answer", sources, release });
  return {
    defaultPolicyFamilyId: DEFAULT_POLICY_ID,
    policyFamilies: [
      { id: DEFAULT_POLICY_ID, name: "Default policy" },
      { id: "fam-open", name: "Open" },
    ],
    sources: [
      { id: "src-notes", name: "Notes" },
      { id: "src-mail", name: "Mail" },
    ],
    levels: [
      {
        id: "level-voice",
        name: "Voice answers",
        revision: 4,
        connectionCount: 0,
        devices: [],
        rules: [answer({ mode: "allowlist", sourceIds: ["src-notes"] }, { mode: "reviewed", policyFamilyId: "fam-open" })],
      },
      {
        id: "level-wide",
        name: "Assistant",
        revision: 1,
        connectionCount: 2,
        devices: [],
        rules: [answer({ mode: "all", sourceIds: [] }, { mode: "unreviewed" })],
      },
      {
        id: "level-reading",
        name: "Reading only",
        revision: 1,
        connectionCount: 1,
        devices: [],
        rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
      },
    ],
  };
}

describe("device access level picker", () => {
  let host;
  let originalDocument;
  let originalWindow;

  const base = {
    id: "device-voice",
    name: "Studio voice",
    kind: "integration",
    pairedAt: 1,
    lastSeenAt: 2,
    online: true,
    capabilities: {},
    accessLevelId: null,
  };

  const answerToken = { id: "tok_voice", deviceId: "device-voice", scopes: ["answer"], createdAt: 1 };

  const cardProps = (overrides = {}) => ({
    device: { ...base },
    isThis: false,
    tokens: [answerToken],
    expanded: true,
    onToggle: vi.fn(),
    onRevokeDevice: vi.fn(),
    onForgetDevice: vi.fn(),
    onRevokeToken: vi.fn(),
    accessOverview: accessOverview(),
    onSetDeviceLevel: vi.fn(async () => {}),
    ...overrides,
  });

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root");
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  async function renderCard(overrides = {}) {
    await act(async () => {
      render(h(DeviceCard, cardProps(overrides)), host);
    });
    return host.querySelector(".devices-card-access select");
  }

  // linkedom's select.value is getter-only, so tests drive a change by
  // defining the value on the element and read the selection from the
  // rendered attribute.
  async function pick(picker, value) {
    Object.defineProperty(picker, "value", { value, configurable: true });
    await act(async () => {
      picker.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  }

  function selectedValue() {
    return host.querySelector(".devices-card-access select").getAttribute("value");
  }

  function optionLabels(picker) {
    return [...picker.querySelectorAll("option")].map((o) => o.textContent);
  }

  function terms() {
    return host.querySelector(".devices-card-access > .devices-muted").textContent;
  }

  test("offers every level that can answer, by name, and says none refuses questions", async () => {
    const picker = await renderCard();
    expect(optionLabels(picker)).toEqual([
      "No access level — questions refused",
      "Assistant",
      "Voice answers",
    ]);
    expect(selectedValue()).toBe("");
    expect(terms()).toContain("This integration's questions are refused until you choose an access level.");
  });

  test("names what the chosen level lets answers use", async () => {
    await renderCard({ device: { ...base, accessLevelId: "level-voice" } });
    expect(selectedValue()).toBe("level-voice");
    expect(terms()).toContain("Answers use 1 of 2 sources, reviewed under “Open”.");
    await renderCard({ device: { ...base, accessLevelId: "level-wide" } });
    expect(terms()).toContain("Answers use all sources, released without privacy review.");
  });

  test("saves a chosen level with the revision it was shown at, and no level as null", async () => {
    const onSetDeviceLevel = vi.fn(async () => {});
    await pick(await renderCard({ onSetDeviceLevel }), "level-voice");
    expect(onSetDeviceLevel).toHaveBeenCalledWith("device-voice", "level-voice", 4);

    await pick(
      await renderCard({ device: { ...base, accessLevelId: "level-voice" }, onSetDeviceLevel }),
      "",
    );
    expect(onSetDeviceLevel).toHaveBeenLastCalledWith("device-voice", null, undefined);
  });

  test("locks the picker and announces the save while it is in flight", async () => {
    const onSetDeviceLevel = vi.fn(() => new Promise(() => {}));
    await pick(await renderCard({ onSetDeviceLevel }), "level-wide");
    expect(host.querySelector(".devices-card-access select").hasAttribute("disabled")).toBe(true);
    expect(host.querySelector(".devices-card-access [aria-live]").textContent).toBe("Saving…");
  });

  test("a refused save says why and keeps the stored level selected", async () => {
    const onSetDeviceLevel = vi.fn(async () => {
      throw Object.assign(new Error("Conflict"), { status: 409, serverMessage: "stale-revision" });
    });
    await pick(
      await renderCard({ device: { ...base, accessLevelId: "level-voice" }, onSetDeviceLevel }),
      "level-wide",
    );
    await act(async () => {});
    expect(host.querySelector(".devices-card-access [role=alert]")?.textContent).toContain(
      "That access level just changed",
    );
    expect(selectedValue()).toBe("level-voice");
  });

  test("names a level the device is on that can no longer answer", async () => {
    for (const accessLevelId of ["level-gone", "level-reading"]) {
      const picker = await renderCard({ device: { ...base, accessLevelId } });
      expect(selectedValue()).toBe(accessLevelId);
      expect(optionLabels(picker)[0]).toBe("Unavailable access level — questions refused");
      expect(terms()).toContain("this integration's questions are refused");
    }
  });

  test("shows only on integrations: live ones, or revoked ones still on a level", async () => {
    expect(await renderCard({ accessOverview: null })).toBeNull();
    // The operator's own devices read the corpus directly; a level would bound nothing.
    expect(await renderCard({ device: { ...base, kind: "cli" } })).toBeNull();
    expect(await renderCard({ device: { ...base, revokedAt: 3 } })).toBeNull();
    await renderCard({ device: { ...base, revokedAt: 3, accessLevelId: "level-voice" } });
    expect(host.querySelector(".devices-card-access")).not.toBeNull();
  });

  test("a revoked integration shows its kept level as text, and can only be taken off it", async () => {
    const onSetDeviceLevel = vi.fn(async () => {});
    const picker = await renderCard({
      device: { ...base, revokedAt: 3, accessLevelId: "level-voice" },
      onSetDeviceLevel,
    });
    // It cannot be put on another level, so it is offered none.
    expect(picker).toBeNull();
    expect(host.querySelector(".devices-access-level-name")?.textContent).toBe("Voice answers");
    expect(terms()).toContain("A repair brings this integration back on this level");
    const remove = [...host.querySelectorAll(".devices-card-access button")].find(
      (button) => button.textContent === "Remove",
    );
    await act(async () => {
      remove.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    expect(onSetDeviceLevel).toHaveBeenCalledWith("device-voice", null, undefined);

    await renderCard({ device: { ...base, revokedAt: 3, accessLevelId: "level-gone" } });
    expect(host.querySelector(".devices-access-level-name")?.textContent).toBe("Unavailable access level");
  });
});

describe("devices view access level save", () => {
  let host;
  let originalDocument;
  let originalWindow;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root");
    apiMocks.listDevices.mockResolvedValue({
      items: [
        {
          id: "device-voice",
          name: "Studio voice",
          kind: "integration",
          pairedAt: Date.now(),
          lastSeenAt: Date.now(),
          online: true,
          capabilities: {},
          accessLevelId: null,
        },
      ],
    });
    apiMocks.getAccessOverview.mockResolvedValue(accessOverview());
    apiMocks.listTokens.mockResolvedValue({
      items: [{ id: "tok_voice", deviceId: "device-voice", scopes: ["answer"], createdAt: 1 }],
    });
    apiMocks.getFleetDoctor.mockResolvedValue({ devices: [] });
    apiMocks.setDeviceAccessLevel.mockReset();
    apiMocks.setDeviceAccessLevel.mockResolvedValue({ deviceId: "device-voice", level: null });
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    apiMocks.listTokens.mockResolvedValue({ items: [] });
    apiMocks.getAccessOverview.mockResolvedValue({ levels: [] });
  });

  async function openCard() {
    await act(async () => {
      render(h(DevicesView, {}), host);
    });
    await vi.waitFor(() => {
      expect(host.querySelector(".devices-card-toggle")).not.toBeNull();
    });
    await act(async () => host.querySelector(".devices-card-toggle").click());
  }

  async function pickInView(value) {
    const picker = host.querySelector(".devices-card-access select");
    Object.defineProperty(picker, "value", { value, configurable: true });
    await act(async () => {
      picker.dispatchEvent(new window.Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  test("a link naming a device opens that device's card", async () => {
    await act(async () => {
      render(h(DevicesView, { focusDeviceId: "device-voice" }), host);
    });
    await vi.waitFor(() => {
      expect(host.querySelector("#device-device-voice.expanded")).not.toBeNull();
    });
    expect(host.querySelector("#device-device-voice .devices-card-access")).not.toBeNull();
  });

  test("a save re-renders the card from what the gateway now says", async () => {
    await openCard();
    apiMocks.listDevices.mockResolvedValue({
      items: [
        {
          id: "device-voice",
          name: "Studio voice",
          kind: "integration",
          pairedAt: Date.now(),
          lastSeenAt: Date.now(),
          online: true,
          capabilities: {},
          accessLevelId: "level-voice",
        },
      ],
    });
    await pickInView("level-voice");
    // The terms line is rendered from the refreshed device, not the pick.
    await vi.waitFor(() => {
      expect(host.querySelector(".devices-card-access > .devices-muted").textContent).toContain(
        "1 of 2 sources, reviewed under “Open”",
      );
    });
  });

  test("a stale revision re-reads the levels, so choosing again sends the new one", async () => {
    await openCard();
    apiMocks.setDeviceAccessLevel.mockRejectedValueOnce(
      Object.assign(new Error("Conflict"), { status: 409, serverMessage: "stale-revision" }),
    );
    const moved = accessOverview();
    moved.levels[0].revision = 5;
    apiMocks.getAccessOverview.mockResolvedValue(moved);
    await pickInView("level-voice");
    expect(host.querySelector(".devices-card-access [role=alert]")?.textContent).toContain(
      "just changed",
    );
    await pickInView("level-voice");
    expect(apiMocks.setDeviceAccessLevel).toHaveBeenLastCalledWith("device-voice", "level-voice", 5);
  });

  test("a device on a level the page has not seen re-reads the levels instead of calling it unavailable", async () => {
    const withNew = accessOverview();
    withNew.levels.push({
      id: "level-new",
      name: "Newer answers",
      revision: 1,
      connectionCount: 0,
      devices: [],
      rules: [{ capability: "answer", sources: { mode: "all", sourceIds: [] }, release: { mode: "unreviewed" } }],
    });
    apiMocks.listDevices.mockResolvedValue({
      items: [
        {
          id: "device-voice",
          name: "Studio voice",
          kind: "integration",
          pairedAt: Date.now(),
          lastSeenAt: Date.now(),
          online: true,
          capabilities: {},
          accessLevelId: "level-new",
        },
      ],
    });
    apiMocks.getAccessOverview
      .mockResolvedValueOnce(accessOverview())
      .mockResolvedValue(withNew);
    await openCard();
    await vi.waitFor(() => {
      expect(
        [...host.querySelectorAll(".devices-card-access option")].map((o) => o.textContent),
      ).toContain("Newer answers");
    });
    expect(host.querySelector(".devices-card-access select").getAttribute("value")).toBe("level-new");
  });

  test("without the access overview the picker stays hidden and the page still renders", async () => {
    apiMocks.getAccessOverview.mockRejectedValue(new Error("unavailable"));
    await openCard();
    expect(host.querySelector(".devices-card-access")).toBeNull();
    expect(host.textContent).toContain("Studio voice");
  });

  test("picking a level saves it and refreshes both the devices and the levels", async () => {
    await act(async () => {
      render(h(DevicesView, {}), host);
    });
    await vi.waitFor(() => {
      expect(host.querySelector(".devices-card-toggle")).not.toBeNull();
    });
    const devicesBefore = apiMocks.listDevices.mock.calls.length;
    const overviewsBefore = apiMocks.getAccessOverview.mock.calls.length;

    const toggle = host.querySelector(".devices-card-toggle");
    await act(async () => toggle.click());
    const picker = host.querySelector(".devices-card-access select");
    Object.defineProperty(picker, "value", { value: "level-voice", configurable: true });
    await act(async () => {
      picker.dispatchEvent(new window.Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(apiMocks.setDeviceAccessLevel).toHaveBeenCalledWith("device-voice", "level-voice", 4);
    expect(apiMocks.listDevices.mock.calls.length).toBeGreaterThan(devicesBefore);
    expect(apiMocks.getAccessOverview.mock.calls.length).toBeGreaterThan(overviewsBefore);
  });
});
