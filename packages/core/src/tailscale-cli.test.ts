// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  tailscaleCliCandidates,
  tailscaleCliEnv,
  tailscaleIsRunningStatus,
} from "./tailscale-cli.js";

describe("Tailscale CLI candidates", () => {
  test("Linux uses the CLI on PATH", () => {
    expect(tailscaleCliCandidates("linux", "/home/maya")).toEqual([
      { file: "tailscale", bundledApp: false },
    ]);
  });

  test("macOS also checks system and user app bundles", () => {
    const candidates = tailscaleCliCandidates("darwin", "/Users/maya");
    expect(candidates).toEqual([
      { file: "tailscale", bundledApp: false },
      { file: "/Applications/Tailscale.app/Contents/MacOS/Tailscale", bundledApp: true },
      {
        file: "/Users/maya/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        bundledApp: true,
      },
    ]);
    expect(tailscaleCliEnv(candidates[1]!, { HOME: "/Users/maya" })).toEqual({
      HOME: "/Users/maya",
      TAILSCALE_BE_CLI: "1",
    });
  });

  test("a successful status process can still be logged out", () => {
    expect(tailscaleIsRunningStatus('{"BackendState":"NeedsLogin"}')).toBe(false);
    expect(tailscaleIsRunningStatus('{"BackendState":"Running"}')).toBe(true);
    expect(tailscaleIsRunningStatus("not json")).toBe(false);
  });
});
