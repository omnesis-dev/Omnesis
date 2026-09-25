// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CODEX_RUNTIME_COMPAT,
  isSupportedCodexCliVersion,
  isTestedCodexCliVersion,
} from "./codex-compat.js";

describe("Codex runtime compatibility", () => {
  it("keeps the package dependency locked to the tested runtime", async () => {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies?: Record<string, string>;
    };

    expect(manifest.dependencies?.[CODEX_RUNTIME_COMPAT.packageName]).toBe(
      CODEX_RUNTIME_COMPAT.testedVersion,
    );
  });

  it("accepts the draining and tested minors but names only the exact target as tested", () => {
    expect(isSupportedCodexCliVersion("0.142.9")).toBe(true);
    expect(isSupportedCodexCliVersion("0.151.7")).toBe(true);
    expect(isSupportedCodexCliVersion("0.150.0")).toBe(false);
    expect(isTestedCodexCliVersion("0.151.0")).toBe(true);
    expect(isTestedCodexCliVersion("0.151.1")).toBe(false);
  });
});
