// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { HttpGatewayClient, GatewayWsClient } from "@omnesis/gateway-client";

/**
 * Cross-boundary export-resolution smoke test (#384). Imports through the
 * package entry rather than a relative path so it fails if the `index.ts`
 * ever regresses to `export *` — which vite/vitest does not follow across
 * a workspace-package boundary (#414).
 */
describe("@omnesis/gateway-client entry", () => {
  test("re-exports the client classes", () => {
    expect(HttpGatewayClient).toBeDefined();
    expect(typeof HttpGatewayClient).toBe("function");
    expect(GatewayWsClient).toBeDefined();
    expect(typeof GatewayWsClient).toBe("function");
  });
});
