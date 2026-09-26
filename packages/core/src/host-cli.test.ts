// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { homebrewCliPaths, mkcertCliCandidates } from "./host-cli.js";

// The gateway's launchd PATH: the node bin dir, then the service baseline.
const SERVICE_PATH = "/opt/homebrew/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

describe("Homebrew CLI paths", () => {
  test("a launchd service's PATH still reaches Homebrew's /opt/homebrew/bin", () => {
    expect(homebrewCliPaths("mkcert", "darwin", SERVICE_PATH)).toEqual([
      "/opt/homebrew/bin/mkcert",
    ]);
    expect(mkcertCliCandidates("darwin", SERVICE_PATH)).toEqual([
      "mkcert",
      "/opt/homebrew/bin/mkcert",
    ]);
  });

  test("both prefixes when PATH covers neither, none when it covers both", () => {
    expect(homebrewCliPaths("mkcert", "darwin", "/usr/bin:/bin")).toEqual([
      "/opt/homebrew/bin/mkcert",
      "/usr/local/bin/mkcert",
    ]);
    expect(
      homebrewCliPaths("mkcert", "darwin", "/opt/homebrew/bin:/usr/local/bin:/usr/bin"),
    ).toEqual([]);
  });

  test("outside macOS only the PATH lookup", () => {
    expect(mkcertCliCandidates("linux", "/usr/bin:/bin")).toEqual(["mkcert"]);
  });
});
