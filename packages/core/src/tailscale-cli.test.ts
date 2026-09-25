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
    expect(tailscaleCliCandidates("linux", "/home/maya", "/usr/bin:/bin")).toEqual([
      { file: "tailscale", bundledApp: false },
    ]);
  });

  test("macOS also checks Homebrew's CLI and the system and user app bundles", () => {
    const candidates = tailscaleCliCandidates("darwin", "/Users/maya", "/usr/bin:/bin");
    expect(candidates).toEqual([
      { file: "tailscale", bundledApp: false },
      { file: "/opt/homebrew/bin/tailscale", bundledApp: false },
      { file: "/usr/local/bin/tailscale", bundledApp: false },
      { file: "/Applications/Tailscale.app/Contents/MacOS/Tailscale", bundledApp: true },
      {
        file: "/Users/maya/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        bundledApp: true,
      },
    ]);
    expect(tailscaleCliEnv(candidates[3]!, { HOME: "/Users/maya" })).toEqual({
      HOME: "/Users/maya",
      TAILSCALE_BE_CLI: "1",
    });
    expect(tailscaleCliEnv(candidates[1]!, { HOME: "/Users/maya" })).toEqual({
      HOME: "/Users/maya",
    });
  });

  test("a launchd service's PATH still reaches Homebrew's CLI in /opt/homebrew", () => {
    // The gateway's launchd PATH: the node bin dir, then the service baseline.
    const servicePath =
      "/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    expect(tailscaleCliCandidates("darwin", "/Users/maya", servicePath).map((c) => c.file)).toEqual(
      [
        "tailscale",
        "/opt/homebrew/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/Users/maya/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      ],
    );
  });

  test("a Homebrew directory already on PATH is not asked twice", () => {
    const loginPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
    expect(tailscaleCliCandidates("darwin", "/Users/maya", loginPath).map((c) => c.file)).toEqual([
      "tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/Users/maya/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ]);
  });

  test("a successful status process can still be logged out", () => {
    expect(tailscaleIsRunningStatus('{"BackendState":"NeedsLogin"}')).toBe(false);
    expect(tailscaleIsRunningStatus('{"BackendState":"Running"}')).toBe(true);
    expect(tailscaleIsRunningStatus("not json")).toBe(false);
  });
});
