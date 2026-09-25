// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  CAPTURE_CONTENT_SCRIPT,
  hasCaptureAccess,
  hasCaptureContentScript,
  syncCaptureContentScript,
} from "./content-registration.js";

function scripting(registered: boolean) {
  return {
    getRegisteredContentScripts: vi.fn(() =>
      Promise.resolve(registered ? [CAPTURE_CONTENT_SCRIPT] : []),
    ),
    registerContentScripts: vi.fn(() => Promise.resolve()),
    updateContentScripts: vi.fn(() => Promise.resolve()),
    unregisterContentScripts: vi.fn(() => Promise.resolve()),
  };
}

describe("dynamic capture content script", () => {
  it("registers once after optional HTTPS access is granted", async () => {
    const api = scripting(false);
    await syncCaptureContentScript(true, api);
    expect(api.registerContentScripts).toHaveBeenCalledExactlyOnceWith([CAPTURE_CONTENT_SCRIPT]);
    expect(api.updateContentScripts).not.toHaveBeenCalled();
    expect(api.unregisterContentScripts).not.toHaveBeenCalled();
  });

  it("updates a persisted registration when the capture definition changes", async () => {
    const api = scripting(true);
    api.getRegisteredContentScripts.mockResolvedValue([
      { ...CAPTURE_CONTENT_SCRIPT, js: ["old-content.js"] },
    ]);

    await syncCaptureContentScript(true, api);

    expect(api.updateContentScripts).toHaveBeenCalledExactlyOnceWith([CAPTURE_CONTENT_SCRIPT]);
    expect(api.registerContentScripts).not.toHaveBeenCalled();
  });

  it("unregisters after HTTPS access is revoked", async () => {
    const api = scripting(true);
    await syncCaptureContentScript(false, api);
    expect(api.unregisterContentScripts).toHaveBeenCalledExactlyOnceWith({
      ids: [CAPTURE_CONTENT_SCRIPT.id],
    });
  });

  it("is idempotent when registration already matches permission state", async () => {
    const granted = scripting(true);
    const revoked = scripting(false);
    await syncCaptureContentScript(true, granted);
    await syncCaptureContentScript(false, revoked);
    expect(granted.registerContentScripts).not.toHaveBeenCalled();
    expect(granted.updateContentScripts).not.toHaveBeenCalled();
    expect(granted.unregisterContentScripts).not.toHaveBeenCalled();
    expect(revoked.registerContentScripts).not.toHaveBeenCalled();
    expect(revoked.updateContentScripts).not.toHaveBeenCalled();
    expect(revoked.unregisterContentScripts).not.toHaveBeenCalled();
  });

  it("reports whether dynamic injection is actually registered", async () => {
    await expect(hasCaptureContentScript(scripting(true))).resolves.toBe(true);
    await expect(hasCaptureContentScript(scripting(false))).resolves.toBe(false);
    const stale = scripting(true);
    stale.getRegisteredContentScripts.mockResolvedValue([
      { ...CAPTURE_CONTENT_SCRIPT, matches: ["https://old.example.com/*"] },
    ]);
    await expect(hasCaptureContentScript(stale)).resolves.toBe(false);
  });

  it("requires the host grant, registration, and fail-closed mirror to agree", async () => {
    const yes = () => Promise.resolve(true);
    const no = () => Promise.resolve(false);
    await expect(hasCaptureAccess(yes, yes, yes)).resolves.toBe(true);
    await expect(hasCaptureAccess(no, yes, yes)).resolves.toBe(false);
    await expect(hasCaptureAccess(yes, no, yes)).resolves.toBe(false);
    await expect(hasCaptureAccess(yes, yes, no)).resolves.toBe(false);
  });
});
