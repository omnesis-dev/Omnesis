// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** Debug shells support development runtime overrides and cannot become distribution inputs. */
export async function assertReleaseApplication(app, run = execFileSync) {
  for (const [relative, identifier] of [
    ["Contents/Info.plist", "dev.omnesis.desktop"],
    [
      "Contents/Library/LoginItems/OmnesisBackground.app/Contents/Info.plist",
      "dev.omnesis.desktop.background",
    ],
  ]) {
    const path = join(app, relative);
    let info;
    try {
      info = await lstat(path);
    } catch {
      throw new Error("Distribution requires a complete Release application and background helper");
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65536)
      throw new Error("Distribution application metadata is invalid");
    let metadata;
    try {
      metadata = JSON.parse(
        String(
          run("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
            encoding: "utf8",
            maxBuffer: 65536,
            timeout: 10000,
          }),
        ),
      );
    } catch {
      throw new Error("Distribution application metadata could not be read");
    }
    if (
      metadata?.CFBundleIdentifier !== identifier ||
      metadata?.OmnesisBuildConfiguration !== "Release"
    )
      throw new Error(
        "Distribution requires Release builds of the application and background helper",
      );
  }
}
