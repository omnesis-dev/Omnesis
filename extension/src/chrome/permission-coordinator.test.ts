// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { CapturePermissionCoordinator } from "./permission-coordinator.js";

describe("CapturePermissionCoordinator", () => {
  it("reconciles any changed origin rather than only the wildcard string", async () => {
    const saveState = vi.fn(() => Promise.resolve());
    const clear = vi.fn(() => Promise.resolve());
    const coordinator = new CapturePermissionCoordinator({
      hasPermission: () => Promise.resolve(false),
      saveState,
      syncContentScript: () => Promise.resolve(),
      clearUnauthorizedHandoffs: clear,
      refreshStatus: () => Promise.resolve(),
    });

    await coordinator.handleRemoved({ origins: ["https://news.example.com/*"] });

    expect(saveState).toHaveBeenCalledWith(false);
    expect(clear).toHaveBeenCalledOnce();
  });

  it("captures remove and re-add observations while earlier work is blocked", async () => {
    let releaseFirst: ((value: boolean) => void) | undefined;
    const first = new Promise<boolean>((resolve) => {
      releaseFirst = resolve;
    });
    const states: boolean[] = [];
    let reads = 0;
    let actual = true;
    const clear = vi.fn(() => Promise.resolve());
    const coordinator = new CapturePermissionCoordinator({
      hasPermission: () => {
        reads += 1;
        return reads === 1 ? first : Promise.resolve(actual);
      },
      saveState: (state) => {
        states.push(state);
        return Promise.resolve();
      },
      syncContentScript: () => Promise.resolve(),
      clearUnauthorizedHandoffs: clear,
      refreshStatus: () => Promise.resolve(),
    });

    const startup = coordinator.reconcile();
    actual = false;
    const removed = coordinator.handleRemoved({ origins: ["https://news.example.com/*"] });
    actual = true;
    const added = coordinator.handleAdded({ origins: ["https://news.example.com/*"] });
    releaseFirst?.(true);
    await Promise.all([startup, removed, added]);

    expect(states).toEqual([true, false, true]);
    expect(clear).toHaveBeenCalledOnce();
  });

  it("ignores permission events with no host-origin change", async () => {
    const hasPermission = vi.fn(() => Promise.resolve(true));
    const coordinator = new CapturePermissionCoordinator({
      hasPermission,
      saveState: () => Promise.resolve(),
      syncContentScript: () => Promise.resolve(),
      clearUnauthorizedHandoffs: () => Promise.resolve(),
      refreshStatus: () => Promise.resolve(),
    });

    await coordinator.handleAdded({ permissions: ["alarms"] });
    expect(hasPermission).not.toHaveBeenCalled();
  });

  it("does not publish granted state when dynamic registration fails", async () => {
    const saveState = vi.fn(() => Promise.resolve());
    const coordinator = new CapturePermissionCoordinator({
      hasPermission: () => Promise.resolve(true),
      saveState,
      syncContentScript: () => Promise.reject(new Error("registration failed")),
      clearUnauthorizedHandoffs: () => Promise.resolve(),
      refreshStatus: () => Promise.resolve(),
    });

    await expect(coordinator.reconcile()).rejects.toThrow("registration failed");
    expect(saveState).not.toHaveBeenCalledWith(true);
  });

  it("attempts privacy cleanup even when dynamic unregistration fails", async () => {
    const calls: string[] = [];
    const coordinator = new CapturePermissionCoordinator({
      hasPermission: () => Promise.resolve(false),
      saveState: () => {
        calls.push("deactivate");
        return Promise.resolve();
      },
      syncContentScript: () => {
        calls.push("unregister");
        return Promise.reject(new Error("unregistration failed"));
      },
      clearUnauthorizedHandoffs: () => {
        calls.push("clear");
        return Promise.resolve();
      },
      refreshStatus: () => Promise.resolve(),
    });

    await expect(coordinator.reconcile()).rejects.toThrow("unregistration failed");
    expect(calls).toEqual(["deactivate", "unregister", "clear"]);
  });

  it("does not translate an unreadable permission state into revocation", async () => {
    const saveState = vi.fn(() => Promise.resolve());
    const unregister = vi.fn(() => Promise.resolve());
    const clear = vi.fn(() => Promise.resolve());
    const coordinator = new CapturePermissionCoordinator({
      hasPermission: () => Promise.reject(new Error("permission API unavailable")),
      saveState,
      syncContentScript: unregister,
      clearUnauthorizedHandoffs: clear,
      refreshStatus: () => Promise.resolve(),
    });

    await expect(coordinator.reconcile()).rejects.toThrow("permission API unavailable");
    expect(saveState).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("attempts every fail-closed teardown step when deactivation storage fails", async () => {
    const unregister = vi.fn(() => Promise.resolve());
    const clear = vi.fn(() => Promise.resolve());
    const coordinator = new CapturePermissionCoordinator({
      hasPermission: () => Promise.resolve(false),
      saveState: () => Promise.reject(new Error("storage unavailable")),
      syncContentScript: unregister,
      clearUnauthorizedHandoffs: clear,
      refreshStatus: () => Promise.resolve(),
    });

    await expect(coordinator.reconcile()).rejects.toThrow("storage unavailable");
    expect(unregister).toHaveBeenCalledWith(false);
    expect(clear).toHaveBeenCalledOnce();
  });
});
