// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { CAPTURE_PERMISSION_STATE_KEY, PAIRING_KEY } from "./storage.js";
import { applyCaptureStorageAction, captureStorageAction } from "./capture-storage-change.js";

describe("captureStorageAction", () => {
  it("ignores unrelated queue and health writes", () => {
    expect(captureStorageAction({ "omnesis.push.queue.v1": { newValue: "[]" } }, "local")).toBe(
      "none",
    );
    expect(captureStorageAction({ "omnesis.push.checked.v1": { newValue: "{}" } }, "local")).toBe(
      "none",
    );
  });

  it("reconciles pairing replacement and refreshes when permission becomes available", () => {
    expect(captureStorageAction({ [PAIRING_KEY]: { newValue: "{}" } }, "local")).toBe("reconcile");
    expect(
      captureStorageAction({ [CAPTURE_PERMISSION_STATE_KEY]: { newValue: true } }, "local"),
    ).toBe("refresh");
  });

  it("refreshes without cancelling handoffs for a same-identity token refresh", () => {
    const oldValue = JSON.stringify({
      gatewayUrl: "https://gateway.example.com",
      scopes: ["write:web"],
      deviceId: "device-one",
      pairedAt: 1,
    });
    const newValue = JSON.stringify({
      gatewayUrl: "https://gateway.example.com",
      scopes: ["write:web"],
      deviceId: "device-one",
      pairedAt: 2,
    });
    expect(captureStorageAction({ [PAIRING_KEY]: { oldValue, newValue } }, "local")).toBe(
      "refresh",
    );
  });

  it("treats a gateway-version stamp as a same-identity refresh", () => {
    // Exactly the write `saveGatewayVersion` makes after a health probe.
    const base = {
      gatewayUrl: "https://gateway.example.com",
      scopes: ["write:web"],
      deviceId: "device-one",
      pairedAt: 1,
    };
    expect(
      captureStorageAction(
        {
          [PAIRING_KEY]: {
            oldValue: JSON.stringify(base),
            newValue: JSON.stringify({ ...base, gatewayVersion: "0.4.6" }),
          },
        },
        "local",
      ),
    ).toBe("refresh");
  });

  it("cancels old handoffs when the pairing identity changes", () => {
    const oldValue = JSON.stringify({
      gatewayUrl: "https://gateway.example.com",
      scopes: ["write:web"],
      deviceId: "device-one",
      pairedAt: 1,
    });
    const newValue = JSON.stringify({
      gatewayUrl: "https://other-gateway.example.com",
      scopes: ["write:web"],
      deviceId: "device-two",
      pairedAt: 2,
    });
    expect(captureStorageAction({ [PAIRING_KEY]: { oldValue, newValue } }, "local")).toBe(
      "reconcile",
    );
  });

  it("preserves pending handoffs for same-identity reauthorization", () => {
    const cancel = vi.fn();
    const refresh = vi.fn();
    applyCaptureStorageAction("refresh", {
      refresh,
      rejudge: cancel,
      reconcile: cancel,
      deactivate: cancel,
      terminate: cancel,
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("dispatches a re-judge to its own handler and to no other", () => {
    const rejudge = vi.fn();
    const other = vi.fn();
    applyCaptureStorageAction("rejudge", {
      refresh: other,
      rejudge,
      reconcile: other,
      deactivate: other,
      terminate: other,
    });
    expect(rejudge).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  });

  it("reconciles a same-identity replacement with an invalid scope", () => {
    const base = {
      gatewayUrl: "https://gateway.example.com",
      deviceId: "device-one",
      pairedAt: 1,
    };
    expect(
      captureStorageAction(
        {
          [PAIRING_KEY]: {
            oldValue: JSON.stringify({ ...base, scopes: ["write:web"] }),
            newValue: JSON.stringify({ ...base, scopes: ["write:*"] }),
          },
        },
        "local",
      ),
    ).toBe("reconcile");
  });

  it("deactivates on unpair and terminates on permission loss", () => {
    expect(captureStorageAction({ [PAIRING_KEY]: { newValue: undefined } }, "local")).toBe(
      "deactivate",
    );
    expect(
      captureStorageAction({ [CAPTURE_PERMISSION_STATE_KEY]: { newValue: false } }, "local"),
    ).toBe("terminate");
    expect(
      captureStorageAction({ [CAPTURE_PERMISSION_STATE_KEY]: { newValue: undefined } }, "local"),
    ).toBe("terminate");
  });

  it("re-judges the page whenever the capture settings change, and not otherwise", () => {
    const key = "omnesis.capture.policy.v1";
    const empty = JSON.stringify({ policy: { excludedDomains: [] }, fetchedAt: 1 });
    const excluded = JSON.stringify({
      policy: { excludedDomains: ["news.example.com"] },
      fetchedAt: 2,
    });
    // The first copy, and any later change to the settings themselves.
    expect(captureStorageAction({ [key]: { newValue: empty } }, "local")).toBe("rejudge");
    expect(captureStorageAction({ [key]: { oldValue: "", newValue: empty } }, "local")).toBe(
      "rejudge",
    );
    expect(captureStorageAction({ [key]: { oldValue: empty, newValue: excluded } }, "local")).toBe(
      "rejudge",
    );
    // A refresh that re-read the same settings only restamps when they were
    // read; restarting every open page for that would be pure churn.
    const restamped = JSON.stringify({ policy: { excludedDomains: [] }, fetchedAt: 99 });
    // A record that does not parse, or carries no settings, reads as no
    // settings — so it never looks like a change against another such record.
    expect(captureStorageAction({ [key]: { oldValue: "", newValue: "{" } }, "local")).toBe("none");
    expect(
      captureStorageAction({ [key]: { oldValue: "{", newValue: JSON.stringify({}) } }, "local"),
    ).toBe("none");
    expect(captureStorageAction({ [key]: { oldValue: empty, newValue: restamped } }, "local")).toBe(
      "none",
    );
    expect(captureStorageAction({ [key]: { oldValue: empty, newValue: empty } }, "local")).toBe(
      "none",
    );
    // Clearing the copy is a change like any other: the page is judged again
    // and lands on "waiting for capture settings" until the next copy arrives.
    expect(captureStorageAction({ [key]: { oldValue: empty, newValue: "" } }, "local")).toBe(
      "rejudge",
    );
  });

  it("ignores changes from other storage areas", () => {
    expect(captureStorageAction({ [PAIRING_KEY]: { newValue: undefined } }, "sync")).toBe("none");
  });
});
