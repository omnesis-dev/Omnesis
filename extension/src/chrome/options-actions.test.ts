// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  commitBrowserPairing,
  grantCaptureAccess,
  loadInitialOptionsState,
  revokeUnpairedCaptureAccess,
  saveBrowserProfileLabel,
  unpairBrowser,
  withBestEffortRefresh,
} from "./options-actions.js";

function actions(send: (message: unknown) => Promise<unknown>) {
  return {
    requestPermission: vi.fn(() => Promise.resolve()),
    send: vi.fn(send),
  };
}

describe("options pairing actions", () => {
  it("validates the gateway before requesting page access", async () => {
    const deps = actions(() => Promise.resolve({ ok: true }));
    await expect(
      commitBrowserPairing("http://gateway.example.com", "code", "Personal", deps),
    ).rejects.toThrow();
    expect(deps.requestPermission).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("requires and trims the user-visible Chrome profile label before pairing", async () => {
    const deps = actions(() => Promise.resolve({ ok: true }));

    await expect(
      commitBrowserPairing("https://gateway.example.com", "code", "   ", deps),
    ).rejects.toThrow("Enter this Chrome profile's name");
    expect(deps.requestPermission).not.toHaveBeenCalled();

    await commitBrowserPairing("https://gateway.example.com", "code", "  Personal  ", deps);
    expect(deps.send).toHaveBeenCalledWith({
      type: "pair-browser",
      gatewayUrl: "https://gateway.example.com",
      pairingCode: "code",
      profileLabel: "Personal",
    });
  });

  it("never revokes a shared grant when one of two pairing tabs fails", async () => {
    let permissionGranted = false;
    let requests = 0;
    const makeActions = () => ({
      requestPermission: vi.fn(() => {
        permissionGranted = true;
        return Promise.resolve();
      }),
      send: vi.fn(() => {
        requests += 1;
        return Promise.resolve(
          requests === 1 ? { ok: true } : { ok: false, reason: "Pairing code expired" },
        );
      }),
    });
    const first = makeActions();
    const second = makeActions();

    const settled = await Promise.allSettled([
      commitBrowserPairing("https://gateway.example.com", "valid-code", "Personal", first),
      commitBrowserPairing("https://gateway.example.com", "expired-code", "Work", second),
    ]);

    expect(settled.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(permissionGranted).toBe(true);
  });

  it("updates the profile label without replacing the pairing", async () => {
    const deps = actions(() => Promise.resolve({ ok: true }));
    await saveBrowserProfileLabel("  Work  ", deps);
    expect(deps.send).toHaveBeenCalledWith({ type: "set-profile-label", profileLabel: "Work" });
  });

  it("surfaces the worker-owned permission cleanup warning", async () => {
    const deps = {
      requestPermission: vi.fn(() => Promise.resolve()),
      send: vi.fn(() =>
        Promise.resolve({
          ok: true,
          warning: "Chrome kept HTTPS page access after the extension was unpaired",
        }),
      ),
    };

    await expect(unpairBrowser(deps)).resolves.toMatch(/Chrome kept HTTPS page access/);
  });

  it("reports clean unpair when Chrome access is verified absent", async () => {
    const deps = actions(() => Promise.resolve({ ok: true }));
    await expect(unpairBrowser(deps)).resolves.toBeNull();
  });

  it("removes unpaired page access through the worker", async () => {
    const deps = actions(() => Promise.resolve({ ok: true }));
    await expect(revokeUnpairedCaptureAccess(deps)).resolves.toBeNull();
    expect(deps.send).toHaveBeenCalledWith({ type: "revoke-capture-access" });
  });

  it("surfaces unpaired page-access cleanup failures", async () => {
    const deps = actions(() => Promise.resolve({ ok: false, reason: "permission retained" }));
    await expect(revokeUnpairedCaptureAccess(deps)).rejects.toThrow("permission retained");
  });

  it("surfaces worker activation failure after Chrome grants permission", async () => {
    const deps = actions(() => Promise.reject(new Error("worker asleep")));
    await expect(grantCaptureAccess(deps)).rejects.toThrow("worker asleep");
    expect(deps.requestPermission).toHaveBeenCalledOnce();
  });

  it("surfaces a negative activation acknowledgement", async () => {
    const deps = actions(() => Promise.resolve({ ok: false, reason: "registration failed" }));
    await expect(grantCaptureAccess(deps)).rejects.toThrow("registration failed");
  });

  it.each(["pair", "unpair", "grant"] as const)(
    "does not relabel a committed %s action when rendering fails",
    async (kind) => {
      const deps = actions(() => Promise.resolve({ ok: true }));
      const action: () => Promise<unknown> =
        kind === "pair"
          ? () => commitBrowserPairing("https://gateway.example.com", "code", "Personal", deps)
          : kind === "unpair"
            ? () => unpairBrowser(deps)
            : () => grantCaptureAccess(deps);

      await expect(
        withBestEffortRefresh(action, () => Promise.reject(new Error("storage read failed"))),
      ).resolves.not.toBeInstanceOf(Error);
    },
  );

  it("contains initial settings-load failures for actionable UI reporting", async () => {
    await expect(
      loadInitialOptionsState(
        () => Promise.reject(new Error("storage unavailable")),
        () => Promise.resolve(),
      ),
    ).resolves.toBe("storage unavailable");
  });
});
