// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { getHostFleetUpdate, startHostFleetUpdate, polling } = vi.hoisted(() => ({
  getHostFleetUpdate: vi.fn(),
  startHostFleetUpdate: vi.fn(),
  polling: { callback: null as null | (() => void) },
}));

vi.mock("../api.js", () => ({ getHostFleetUpdate, startHostFleetUpdate }));
vi.mock("../lib/use-visible-poll.js", () => ({
  useVisiblePoll: (callback: () => void, _interval: number, opts: { enabled: boolean }) => {
    polling.callback = opts.enabled ? callback : null;
  },
}));

// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { FleetHostUpdate, deviceUpdatesActive } from "./fleet-host-update.js";

const release = { currentVersion: "1.4.0", latestVersion: "1.5.0" };
const plan = {
  id: "plan-fictional",
  currentVersion: "1.4.0",
  targetVersion: "1.5.0",
  supported: true,
  devices: [
    {
      id: "device-collector",
      name: "Studio collector",
      version: "1.4.0",
      online: true,
      disposition: { kind: "update" },
    },
    {
      id: "device-phone",
      name: "Example phone",
      version: "1.4.0",
      online: false,
      disposition: {
        kind: "refused",
        reason: "Update the app on the device; its store delivers the new build.",
      },
    },
  ],
};

test("release polling ignores an unrelated CLI commit update", () => {
  const operation = {
    state: "succeeded",
    completedAt: new Date(Date.now()).toISOString(),
  };
  expect(
    deviceUpdatesActive(
      {
        ...plan,
        devices: [{ desiredVersion: `commit:${"a".repeat(40)}`, updateState: "dispatched" }],
      },
      operation,
    ),
  ).toBe(false);
});

describe("FleetHostUpdate", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
    polling.callback = null;
    getHostFleetUpdate.mockReset().mockResolvedValue({ plan: null, operation: null });
    startHostFleetUpdate.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    render(null, host);
    vi.restoreAllMocks();
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  async function mount() {
    await act(async () => {
      render(h(FleetHostUpdate, { releaseUpdate: release }), host);
    });
    await vi.waitFor(() => expect(getHostFleetUpdate).toHaveBeenCalled());
  }

  test("reviews the exact gateway and device transition before starting the opaque plan", async () => {
    getHostFleetUpdate
      .mockResolvedValueOnce({ plan: null, operation: null })
      .mockResolvedValueOnce({ plan, operation: null });
    startHostFleetUpdate.mockResolvedValue({
      operation: {
        id: "operation-fictional",
        targetVersion: "1.5.0",
        state: "queued",
        startedAt: "2026-09-16T10:00:00.000Z",
        updatedAt: "2026-09-16T10:00:00.000Z",
      },
    });
    await mount();
    await vi.waitFor(() =>
      expect(host.querySelector(".fleet-host-update-button")).not.toBeNull(),
    );

    await act(async () => {
      (host.querySelector(".fleet-host-update-button") as HTMLButtonElement).click();
    });
    await vi.waitFor(() => expect(host.querySelector(".confirm-modal")).not.toBeNull());
    const confirmation = host.querySelector(".confirm-modal-body")?.textContent ?? "";
    expect(confirmation).toContain("Gateway: 1.4.0 → 1.5.0");
    expect(confirmation).toContain("Then update all commandable devices to 1.5.0");
    expect(confirmation).toContain("Studio collector: 1.4.0 → 1.5.0");
    expect(confirmation).toContain("Example phone: not commanded");
    expect(confirmation).toContain("store delivers the new build");

    await act(async () => {
      (host.querySelector(".confirm-modal .btn-primary") as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(startHostFleetUpdate).toHaveBeenCalledWith("plan-fictional"));
    expect(host.textContent).toContain("Update queued");
    expect(host.textContent).toContain("Target 1.5.0");
  });

  test("keeps an unsupported action disabled and names the terminal fallback", async () => {
    getHostFleetUpdate.mockResolvedValue({
      plan: {
        ...plan,
        supported: false,
        unsupportedReason: "This gateway is not managed by a supported user service.",
      },
      operation: null,
    });
    await mount();

    const button = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Update fleet",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(host.textContent).toContain("not managed by a supported user service");
    expect(host.querySelector("code")?.textContent).toBe("omnesis update --fleet");
  });

  test("resumes a durable operation and retains it across the expected restart outage", async () => {
    const running = {
      id: "operation-running",
      targetVersion: "1.5.0",
      state: "running",
      startedAt: "2026-09-16T10:00:00.000Z",
      updatedAt: "2026-09-16T10:01:00.000Z",
      detail: "Restarting the gateway",
    };
    getHostFleetUpdate.mockResolvedValueOnce({ plan, operation: running });
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain("Updating fleet"));
    expect(polling.callback).not.toBeNull();

    getHostFleetUpdate.mockRejectedValueOnce(new TypeError("fetch failed"));
    await act(async () => {
      polling.callback?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain("Gateway is restarting. Reconnecting…");
    expect(host.textContent).toContain("Restarting the gateway");

    getHostFleetUpdate.mockResolvedValueOnce({
      plan,
      operation: {
        ...running,
        state: "succeeded",
        updatedAt: "2026-09-16T10:02:00.000Z",
        completedAt: new Date(Date.now()).toISOString(),
        detail: "Gateway and commandable devices updated.",
      },
    });
    await act(async () => {
      polling.callback?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Fleet update complete"));
    expect(host.textContent).not.toContain("Reconnecting");
  });

  test("polls for the durable operation when the start response is lost to the restart", async () => {
    getHostFleetUpdate.mockResolvedValue({ plan, operation: null });
    startHostFleetUpdate.mockRejectedValueOnce(new TypeError("fetch failed"));
    await mount();
    await vi.waitFor(() => expect(host.querySelector(".fleet-host-update-button")).not.toBeNull());

    await act(async () => {
      (host.querySelector(".fleet-host-update-button") as HTMLButtonElement).click();
    });
    await vi.waitFor(() => expect(host.querySelector(".confirm-modal")).not.toBeNull());
    await act(async () => {
      (host.querySelector(".confirm-modal .btn-primary") as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await vi.waitFor(() => expect(host.textContent).toContain("Gateway is restarting. Reconnecting"));
    expect(host.textContent).toContain("Update queued");
    expect(polling.callback).not.toBeNull();

    getHostFleetUpdate.mockResolvedValueOnce({
      plan,
      operation: {
        id: "operation-after-restart",
        targetVersion: "1.5.0",
        state: "running",
        startedAt: "2026-09-16T10:00:00.000Z",
        updatedAt: "2026-09-16T10:00:01.000Z",
      },
    });
    await act(async () => {
      polling.callback?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Updating fleet"));
  });

  test("keeps durable per-device results out of the sidebar and opens them in a modal", async () => {
    getHostFleetUpdate.mockResolvedValue({
      plan: {
        ...plan,
        devices: [
          {
            id: "device-offline",
            name: "Offline collector",
            online: false,
            updateState: "pending",
            disposition: { kind: "update" },
          },
          {
            id: "device-failed",
            name: "Failed collector",
            updateState: "failed",
            updateDetail: "The release could not be installed.",
            disposition: { kind: "update" },
          },
          {
            id: "device-agent",
            name: "Fictional agent",
            updateState: "restart-pending",
            updateDetail: "Run fictional-agent gateway restart.",
            disposition: { kind: "update" },
          },
        ],
      },
      operation: {
        id: "operation-complete",
        targetVersion: "1.5.0",
        state: "succeeded",
        startedAt: "2026-09-16T10:00:00.000Z",
        updatedAt: "2026-09-16T10:02:00.000Z",
        completedAt: new Date(Date.now()).toISOString(),
      },
    });
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain("Fleet update complete"));

    const card = host.querySelector(".fleet-host-update") as HTMLElement;
    expect(card.textContent).not.toContain("Offline collector");
    expect(card.textContent).not.toContain("Failed collector");

    await act(async () => {
      (host.querySelector(".fleet-host-update-details-button") as HTMLButtonElement).click();
    });
    const modal = host.querySelector(".modal-panel") as HTMLElement;
    expect(modal).not.toBeNull();
    expect(modal.textContent).toContain("Offline collector: queued until it reconnects");
    expect(modal.textContent).toContain("Failed collector: failed — The release could not be installed");
    expect(modal.textContent).toContain(
      "Fictional agent: manual restart required — Run fictional-agent gateway restart",
    );
  });

  test("keeps polling after host success until every device reaches a terminal state", async () => {
    const succeeded = {
      id: "operation-complete",
      targetVersion: "1.5.0",
      state: "succeeded",
      startedAt: "2026-09-16T10:00:00.000Z",
      updatedAt: "2026-09-16T10:02:00.000Z",
      completedAt: new Date(Date.now()).toISOString(),
    };
    getHostFleetUpdate.mockResolvedValueOnce({
      plan: {
        ...plan,
        devices: [
          {
            id: "device-collector",
            name: "Studio collector",
            desiredVersion: "1.5.0",
            updateState: "pending",
            disposition: { kind: "update" },
          },
        ],
      },
      operation: succeeded,
    });
    await mount();
    await vi.waitFor(() => expect(polling.callback).not.toBeNull());
    await act(async () => {
      (host.querySelector(".fleet-host-update-details-button") as HTMLButtonElement).click();
    });
    await vi.waitFor(() =>
      expect(host.querySelector(".modal-panel")?.textContent).toContain("Studio collector: queued"),
    );

    getHostFleetUpdate.mockResolvedValueOnce({
      plan: {
        ...plan,
        devices: [
          {
            id: "device-collector",
            name: "Studio collector",
            desiredVersion: "1.5.0",
            updateState: "dispatched",
            disposition: { kind: "update" },
          },
        ],
      },
      operation: succeeded,
    });
    await act(async () => {
      polling.callback?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() =>
      expect(host.querySelector(".modal-panel")?.textContent).toContain(
        "Studio collector: update running",
      ),
    );
    expect(polling.callback).not.toBeNull();

    getHostFleetUpdate.mockResolvedValueOnce({
      plan: {
        ...plan,
        devices: [
          {
            id: "device-collector",
            name: "Studio collector",
            desiredVersion: "1.5.0",
            updateState: "installed",
            disposition: { kind: "update" },
          },
        ],
      },
      operation: succeeded,
    });
    await act(async () => {
      polling.callback?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() =>
      expect(host.querySelector(".modal-panel")?.textContent).toContain(
        "Studio collector: installed 1.5.0, waiting for its new connection",
      ),
    );
    expect(polling.callback).not.toBeNull();

    getHostFleetUpdate.mockResolvedValueOnce({
      plan: {
        ...plan,
        devices: [
          {
            id: "device-collector",
            name: "Studio collector",
            version: "1.5.0",
            desiredVersion: null,
            updateState: "installed",
            disposition: { kind: "current" },
          },
        ],
      },
      operation: succeeded,
    });
    await act(async () => {
      polling.callback?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() =>
      expect(host.querySelector(".modal-panel")?.textContent).toContain(
        "Studio collector: already at 1.5.0",
      ),
    );
    expect(getHostFleetUpdate).toHaveBeenCalledTimes(4);
    expect(polling.callback).toBeNull();
  });

  test("stops polling a durably queued offline device after the bounded follow-up window", async () => {
    let now = new Date("2026-09-16T10:00:00.000Z").getTime();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const response = {
      plan: {
        ...plan,
        devices: [
          {
            id: "device-offline",
            name: "Offline collector",
            online: false,
            desiredVersion: "1.5.0",
            updateState: "pending",
            disposition: { kind: "update" },
          },
        ],
      },
      operation: {
        id: "operation-complete",
        targetVersion: "1.5.0",
        state: "succeeded",
        startedAt: "2026-09-16T09:58:00.000Z",
        updatedAt: "2026-09-16T10:00:00.000Z",
        completedAt: "2026-09-16T10:00:00.000Z",
      },
    };
    getHostFleetUpdate.mockImplementation(async () => ({
      ...response,
      plan: {
        ...response.plan,
        devices: response.plan.devices.map((device) => ({ ...device })),
      },
      operation: { ...response.operation },
    }));
    await mount();
    await vi.waitFor(() => expect(polling.callback).not.toBeNull());

    now += 15 * 60_000 + 1;
    await act(async () => {
      polling.callback?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await vi.waitFor(() => expect(polling.callback).toBeNull());
    expect(getHostFleetUpdate).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".fleet-host-update")).toBeNull();
  });

  test("hides a success after 30 seconds while device follow-up polling continues", async () => {
    let now = new Date("2026-09-16T10:00:00.000Z").getTime();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    getHostFleetUpdate.mockResolvedValue({
      plan: {
        ...plan,
        devices: [
          {
            id: "device-offline",
            name: "Offline collector",
            online: false,
            desiredVersion: "1.5.0",
            updateState: "pending",
            disposition: { kind: "update" },
          },
        ],
      },
      operation: {
        id: "operation-complete",
        targetVersion: "1.5.0",
        state: "succeeded",
        completedAt: new Date(now).toISOString(),
      },
    });
    await mount();
    expect(polling.callback).not.toBeNull();

    now += 30_001;
    await act(async () => {
      render(h(FleetHostUpdate, { releaseUpdate: { ...release } }), host);
    });
    expect(host.querySelector(".fleet-host-update")).toBeNull();
    expect(polling.callback).not.toBeNull();
  });

  test("automatically removes a settled success after its short confirmation window", async () => {
    const now = new Date("2026-09-16T10:00:00.000Z");
    const running = {
      id: "operation-complete",
      targetVersion: "1.5.0",
      state: "running",
      startedAt: "2026-09-16T09:58:00.000Z",
      updatedAt: now.toISOString(),
    };
    getHostFleetUpdate.mockResolvedValueOnce({ plan, operation: running });
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain("Updating fleet"));

    vi.useFakeTimers();
    vi.setSystemTime(now);
    getHostFleetUpdate.mockResolvedValueOnce({
      plan,
      operation: {
        ...running,
        state: "succeeded",
        completedAt: now.toISOString(),
        detail: "Gateway and fleet update completed.",
      },
    });
    await act(async () => {
      polling.callback?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(host.textContent).toContain("Fleet update complete");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });
    expect(host.querySelector(".fleet-host-update")).toBeNull();
  });

  test("keeps bounded host failure diagnostics visible and retries a freshly reviewed plan", async () => {
    const longDetail = `The host updater needs attention.\n${"Review the diagnostic context. ".repeat(12)}`;
    const failed = {
      id: "operation-failed",
      targetVersion: "1.5.0",
      state: "failed",
      startedAt: "2026-09-16T10:00:00.000Z",
      updatedAt: "2026-09-16T10:02:00.000Z",
      completedAt: "2026-09-16T10:02:00.000Z",
      detail: longDetail,
      output: "Gateway health failed. Rolled back to 1.4.0.",
    };
    getHostFleetUpdate.mockResolvedValue({ plan, operation: failed });
    startHostFleetUpdate.mockResolvedValue({
      operation: { ...failed, id: "operation-retry", state: "queued", completedAt: undefined },
    });
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain("Fleet update failed"));
    expect(host.querySelector(".fleet-host-update")?.textContent).not.toContain(longDetail);
    expect(host.querySelector(".fleet-host-update")?.textContent).not.toContain(
      "Rolled back to 1.4.0",
    );
    await act(async () => {
      (host.querySelector(".fleet-host-update-details-button") as HTMLButtonElement).click();
    });
    expect(host.querySelector(".modal-panel")?.textContent).toContain(longDetail);
    expect(host.querySelector(".modal-panel")?.textContent).toContain("Rolled back to 1.4.0");
    await act(async () => {
      (host.querySelector(".modal-close") as HTMLButtonElement).click();
    });

    await act(async () => {
      (host.querySelector(".fleet-host-update-button") as HTMLButtonElement).click();
    });
    await vi.waitFor(() => expect(host.querySelector(".confirm-modal")).not.toBeNull());
    await act(async () => {
      (host.querySelector(".confirm-modal .btn-primary") as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(startHostFleetUpdate).toHaveBeenCalledWith("plan-fictional");
    expect(host.textContent).toContain("Update queued");
  });

  test("refreshes a terminal result when the release checker advertises a later target", async () => {
    getHostFleetUpdate
      .mockResolvedValueOnce({
        plan,
        operation: {
          id: "operation-complete",
          targetVersion: "1.5.0",
          state: "succeeded",
          startedAt: "2026-09-16T10:00:00.000Z",
          updatedAt: "2026-09-16T10:02:00.000Z",
          completedAt: new Date(Date.now()).toISOString(),
        },
      })
      .mockResolvedValueOnce({
        plan: { ...plan, id: "later-plan", currentVersion: "1.5.0", targetVersion: "1.6.0" },
        operation: null,
      });
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain("Fleet update complete"));
    await act(async () => {
      (host.querySelector(".fleet-host-update-details-button") as HTMLButtonElement).click();
    });
    expect(host.querySelector(".modal-panel")).not.toBeNull();

    await act(async () => {
      render(
        h(FleetHostUpdate, {
          releaseUpdate: { currentVersion: "1.5.0", latestVersion: "1.6.0" },
        }),
        host,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Omnesis 1.6.0 is available"));
    expect(host.querySelector(".modal-panel")).toBeNull();
  });

  test("does not offer an invalid retry without current gateway evidence", async () => {
    getHostFleetUpdate.mockResolvedValue({
      plan: {
        ...plan,
        id: "operation:operation-failed",
        supported: false,
        unsupportedReason: "No safe retry plan is available. Retry failed device updates from Devices.",
      },
      operation: {
        id: "operation-failed",
        targetVersion: "1.5.0",
        state: "failed",
        startedAt: "2026-09-16T10:00:00.000Z",
        updatedAt: "2026-09-16T10:02:00.000Z",
        completedAt: "2026-09-16T10:02:00.000Z",
      },
    });
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain("Fleet update failed"));
    expect(host.textContent).toContain("Retry failed device updates from Devices");
    expect(host.textContent).not.toContain("Retry update");
  });

  test("labels a post-host retry as a remaining-device retry", async () => {
    getHostFleetUpdate.mockResolvedValue({
      plan: { ...plan, id: "retry-plan", currentVersion: "1.5.0" },
      operation: {
        id: "operation-failed",
        targetVersion: "1.5.0",
        state: "failed",
        startedAt: "2026-09-16T10:00:00.000Z",
        updatedAt: "2026-09-16T10:02:00.000Z",
        completedAt: "2026-09-16T10:02:00.000Z",
      },
    });
    await mount();
    await act(async () => {
      (host.querySelector(".fleet-host-update-button") as HTMLButtonElement).click();
    });
    await vi.waitFor(() => expect(host.querySelector(".confirm-modal")).not.toBeNull());
    expect(host.querySelector(".confirm-modal-body")?.textContent).toContain(
      "Gateway already at 1.5.0; retry remaining devices",
    );
  });
});
