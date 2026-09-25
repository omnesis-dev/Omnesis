// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  CAPTURE_ORIGINS,
  hasCapturePermission,
  needsCapturePermissionRepair,
  requestCapturePermission,
  revokeCapturePermission,
} from "./host-permission.js";
import { CAPTURE_CONTENT_SCRIPT } from "./content-registration.js";

describe("capture host permission", () => {
  it("requests exactly the configured HTTPS origins", async () => {
    const request = vi.fn(() => Promise.resolve(true));

    await requestCapturePermission(request);

    expect(request).toHaveBeenCalledExactlyOnceWith({ origins: CAPTURE_ORIGINS });
  });

  it("keeps requested origins, optional grants, and content-script matches in lockstep", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../public/manifest.json", import.meta.url), "utf8"),
    ) as {
      incognito: string;
      permissions: string[];
      optional_host_permissions: string[];
      content_scripts?: Array<{ matches: string[] }>;
    };

    expect(manifest.optional_host_permissions).toEqual(CAPTURE_ORIGINS);
    expect(manifest.incognito).toBe("not_allowed");
    expect(manifest.permissions).toContain("scripting");
    expect(manifest.content_scripts).toBeUndefined();
    expect(CAPTURE_CONTENT_SCRIPT.matches).toEqual(CAPTURE_ORIGINS);
  });

  it("does not let pairing claim success when the user declines", async () => {
    await expect(requestCapturePermission(() => Promise.resolve(false))).rejects.toThrow(
      /HTTPS page access was not granted/i,
    );
  });

  it("checks and removes the same capture grant", async () => {
    const getAll = vi.fn(() => Promise.resolve({ origins: [] }));
    const remove = vi.fn(() => Promise.resolve(true));

    await expect(hasCapturePermission(getAll)).resolves.toBe(false);
    await expect(revokeCapturePermission(remove)).resolves.toBe(true);
    expect(getAll).toHaveBeenCalledExactlyOnceWith();
    expect(remove).toHaveBeenCalledExactlyOnceWith({ origins: CAPTURE_ORIGINS });
  });

  it("uses Chrome's reported origin inventory for static content-script grants", async () => {
    await expect(
      hasCapturePermission(() => Promise.resolve({ origins: ["https://*/*"] })),
    ).resolves.toBe(true);
  });

  it("offers repair for paired upgrades and later permission revocation", () => {
    expect(needsCapturePermissionRepair(true, false)).toBe(true);
    expect(needsCapturePermissionRepair(true, true)).toBe(false);
    expect(needsCapturePermissionRepair(false, false)).toBe(false);
  });
});
