// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { currentPagePresentation, inspectCurrentPage } from "./current-page.js";

describe("inspectCurrentPage", () => {
  it("does not tell the user to reload an ineligible browser page", async () => {
    const readCaptureStatus = vi.fn();
    const result = await inspectCurrentPage(true, true, {
      queryActiveTab: () => Promise.resolve({ id: 7, url: "chrome://extensions" }),
      readCaptureStatus,
    });
    expect(readCaptureStatus).not.toHaveBeenCalled();
    expect(result.warning).toBeUndefined();
    expect(result.state).toBe("ineligible");
  });

  it("names missing site access instead of judging pages it cannot see", async () => {
    const readCaptureStatus = vi.fn();
    const queryActiveTab = vi.fn();
    const result = await inspectCurrentPage(true, false, { queryActiveTab, readCaptureStatus });
    expect(result.state).toBe("access-missing");
    expect(queryActiveTab).not.toHaveBeenCalled();
    expect(readCaptureStatus).not.toHaveBeenCalled();
  });

  it("treats a tab whose URL Chrome withholds as ineligible, not as a broken page", async () => {
    // Chrome itself omits `url` for tabs the extension has no host permission
    // on (new-tab page, chrome://, http://, the extension's own pages). Those
    // can never be captured, so they must not raise the reload warning.
    const readCaptureStatus = vi.fn();
    const result = await inspectCurrentPage(true, true, {
      queryActiveTab: () => Promise.resolve({ id: 7 }),
      readCaptureStatus,
    });
    expect(readCaptureStatus).not.toHaveBeenCalled();
    expect(result).toEqual({ state: "ineligible", label: "Not eligible" });
  });

  it("names the page's host so the popup can offer to exclude it, and reports a missing policy", async () => {
    const deps = {
      queryActiveTab: async () => ({ id: 3, url: "https://notes.example/page" }),
      readCaptureStatus: async () => ({ state: "policy-pending" as const }),
    };
    expect(await inspectCurrentPage(true, true, deps)).toEqual({
      state: "policy-pending",
      label: "Waiting for capture settings",
      host: "notes.example",
    });
    expect(
      await inspectCurrentPage(true, true, {
        ...deps,
        readCaptureStatus: async () => ({ state: "watching" as const }),
      }),
    ).toMatchObject({ state: "watching", host: "notes.example" });
  });

  it("marks a failed content-script check as an active warning", async () => {
    const result = await inspectCurrentPage(true, true, {
      queryActiveTab: () => Promise.resolve({ id: 7, url: "https://example.com" }),
      readCaptureStatus: () => Promise.reject(new Error("invented content-script failure")),
    });
    expect(result.state).toBe("not-attached");
    expect(result.warning?.trim()).not.toBe("");
    expect(currentPagePresentation(result, "")).toEqual({
      warning: result.warning,
      activeFailure: true,
    });
  });

  it("lets an active attachment failure override a historical notice", () => {
    expect(
      currentPagePresentation(
        {
          state: "not-attached",
          label: "Not watched — reload page",
          warning: "Reload the page to attach capture.",
        },
        "One old upload was discarded.",
      ),
    ).toEqual({ warning: "Reload the page to attach capture.", activeFailure: true });
  });

  it("does not hide a higher-priority live gateway remediation", () => {
    expect(
      currentPagePresentation(
        {
          state: "not-attached",
          label: "Not watched — reload page",
          warning: "Reload the page to attach capture.",
        },
        "Pages are being rejected by the gateway. Re-pair this browser.",
        true,
      ),
    ).toEqual({
      warning: "Pages are being rejected by the gateway. Re-pair this browser.",
      activeFailure: true,
    });
  });
});
