// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { gatewayRuntimeMode } from "./daemon.js";

describe("gateway launch authority", () => {
  test("source CLI invocations and compiled checkouts default to development; staged packages grant production", () => {
    expect(gatewayRuntimeMode("file:///checkout/packages/cli/src/commands/daemon.ts")).toBe(
      "development",
    );
    const root = mkdtempSync(join(tmpdir(), "omnesis-cli-runtime-"));
    try {
      const entry = pathToFileURL(join(root, "dist/commands/daemon.js")).href;
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "omnesis", bin: { omnesis: "src/index.ts" } }),
      );
      expect(gatewayRuntimeMode(entry)).toBe("development");
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "omnesis", bin: { omnesis: "dist/index.js" } }),
      );
      expect(gatewayRuntimeMode(entry)).toBe("production");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("installed source launchers can grant production while harness and operator overrides survive", () => {
    expect(gatewayRuntimeMode("file:///source/daemon.ts", "production")).toBe("production");
    expect(gatewayRuntimeMode("file:///install/daemon.js", "test")).toBe("test");
    expect(gatewayRuntimeMode("file:///install/daemon.js", "development")).toBe("development");
  });
});
