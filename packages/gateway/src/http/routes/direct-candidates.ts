// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { cloudRelayEnabled } from "@omnesis/core";
import { scope } from "../scope.js";
import { gatewayDirectCandidates } from "../services/DirectCandidates.js";
import type { RouteApp } from "./types.js";

export function mountDirectCandidateRoutes(
  app: RouteApp,
  options: { configDir?: string; port?: number },
): void {
  if (!cloudRelayEnabled()) return;
  app.get("/devices/direct-candidates", scope.deviceSelf(), (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(gatewayDirectCandidates(options));
  });
}
