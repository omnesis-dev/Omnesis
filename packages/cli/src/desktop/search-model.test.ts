// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { desktopSearchModel } from "./search-model.js";
import { desktopProfile } from "./environment.js";
import type { DesktopInstall, readDesktopInstall } from "./bootstrap.js";
import type { requestDesktopGateway } from "./gateway-access.js";

const profile = desktopProfile("/fictional/home");
function fixture(
  options: { assigned?: string | null; installed?: boolean; downloading?: boolean } = {},
) {
  const install: DesktopInstall = {
    version: 1,
    owner: "omnesis-desktop",
    mode: "home",
    instance: profile.instance,
    secretService: profile.secretService,
    embedder: "fictional-model",
    memoryLimitMb: 2048,
    phase: "configured",
  };
  const request = vi.fn<typeof requestDesktopGateway>(async (_profile, path) => {
    if (path === "/admin/config")
      return {
        config: {
          inference: {
            assignments: {
              embedder: options.assigned === undefined ? "local/fictional-model" : options.assigned,
            },
          },
        },
      };
    if (path === "/admin/models")
      return {
        installed: options.installed ? [{ id: "fictional-model", sha256: "a".repeat(64) }] : [],
        activeDownloads: options.downloading
          ? [{ modelId: "fictional-model", progress: { downloadedBytes: 1234, totalBytes: 5678 } }]
          : [],
      };
    if (path === "/admin/models/install") return { ok: true, downloadId: "fictional-download" };
    throw new Error("Unexpected request");
  });
  return { install: vi.fn<typeof readDesktopInstall>(async () => install), request };
}

describe("automatic local search setup", () => {
  it("starts the selected local model through gateway capacity/download admission", async () => {
    const deps = fixture();
    expect(await desktopSearchModel(profile, { start: true }, deps)).toMatchObject({
      state: "downloading",
    });
    expect(deps.request).toHaveBeenLastCalledWith(
      profile,
      "/admin/models/install",
      expect.objectContaining({
        method: "POST",
        body: { id: "fictional-model" },
      }),
    );
  });

  it("reports real progress without duplicating an active download", async () => {
    const deps = fixture({ downloading: true });
    expect(await desktopSearchModel(profile, { start: true }, deps)).toEqual({
      state: "downloading",
      downloadedBytes: 1234,
      totalBytes: 5678,
    });
    expect(deps.request).toHaveBeenCalledTimes(2);
  });

  it("uses verified installed manifest state as completion evidence", async () => {
    const deps = fixture({ installed: true });
    expect(await desktopSearchModel(profile, { start: true }, deps)).toEqual({ state: "ready" });
    expect(deps.request).toHaveBeenCalledTimes(2);
  });

  it.each([null, "http:example/custom-model"])("preserves an owner choice %s", async (assigned) => {
    const deps = fixture({ assigned });
    expect(await desktopSearchModel(profile, { start: true }, deps)).toEqual({
      state: "user-selected",
    });
    expect(deps.request).toHaveBeenCalledTimes(1);
  });

  it("leaves interrupted or failed downloads as an explicit retry", async () => {
    const deps = fixture();
    expect(await desktopSearchModel(profile, {}, deps)).toEqual({ state: "needs-download" });
    expect(deps.request).toHaveBeenCalledTimes(2);
  });

  it("refuses an unconfigured host without initiating any network work", async () => {
    const deps = fixture();
    deps.install.mockResolvedValueOnce(null);
    await expect(desktopSearchModel(profile, { start: true }, deps)).rejects.toThrow(/configured/);
    expect(deps.request).not.toHaveBeenCalled();
  });
});
