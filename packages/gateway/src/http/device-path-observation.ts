// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { cloudRelayEnabled, parseConnectionPath, type ConnectionPath } from "@omnesis/core";
import type { DeviceId } from "@omnesis/types";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./routes/types.js";

/**
 * Only an already authenticated device may report its own advisory route.
 * Without the cloud relay opt-in the header is ignored.
 */
export function devicePathObservation(
  note?: (deviceId: DeviceId, path: ConnectionPath) => void,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (cloudRelayEnabled() && auth?.authMethod === "bearer" && auth.deviceId) {
      const path = parseConnectionPath(c.req.header("x-omnesis-connection-path"));
      if (path) note?.(auth.deviceId, path);
    }
    await next();
  };
}
