// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { runWindowsJob } from "@omnesis/platform/windows-job";
import { windowsPowerShellExecutable } from "@omnesis/platform/windows-powershell";

import { quoteCommandArgument } from "./command-display.js";

describe("displayed command arguments", () => {
  it.each(["linux", "darwin", "win32"] as const)(
    "leaves plain words readable on %s",
    (platform) => {
      expect(quoteCommandArgument("--refresh", platform)).toBe("--refresh");
      expect(quoteCommandArgument("omnesis", platform)).toBe("omnesis");
    },
  );

  it("preserves backslashes, apostrophes and shell metacharacters in PowerShell", () => {
    expect(
      quoteCommandArgument(String.raw`C:\fictional space\Maya's $vault; (test)`, "win32"),
    ).toBe(String.raw`'C:\fictional space\Maya''s $vault; (test)'`);
  });

  it("quotes PowerShell splatting and typographic apostrophes", () => {
    expect(quoteCommandArgument("@fictional", "win32")).toBe("'@fictional'");
    expect(quoteCommandArgument("‘fictional’", "win32")).toBe("'‘‘fictional’’'");
  });

  it.runIf(process.platform === "win32")(
    "round-trips displayed arguments through the Windows PowerShell parser",
    async () => {
      const words = [
        "connect",
        "hermes",
        "--dir",
        String.raw`C:\fictional space\Maya's $vault; (test)`,
        "@fictional",
        "‘fictional’",
        "`$value",
        "",
      ];
      const script =
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);" +
        "function omnesis { [Console]::Out.Write((ConvertTo-Json -InputObject @($args) -Compress)) };" +
        `omnesis ${words.map((word) => quoteCommandArgument(word)).join(" ")}`;
      const result = await runWindowsJob(
        windowsPowerShellExecutable(),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { timeoutMs: 30_000 },
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result).not.toHaveProperty("cleanupFailure");
      expect(JSON.parse(Buffer.from(result.stdout).toString("utf8"))).toEqual(words);
    },
    45_000,
  );

  it.each(["linux", "darwin"] as const)("preserves POSIX quoting on %s", (platform) => {
    expect(quoteCommandArgument("/fictional space/Maya's $vault; (test)", platform)).toBe(
      "'/fictional space/Maya'\\''s $vault; (test)'",
    );
  });
});
