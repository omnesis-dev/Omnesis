// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { HttpError } from "../errors.js";
import type { GatewayStorageProtection } from "../../storage-protection.js";
import type { DeviceService } from "../services/DeviceService.js";
import type { AppEnv } from "../routes/types.js";
import type { MiddlewareHandler } from "hono";

/** The opt-in constraint is part of the stored device, not a mutable request header. */
export function storageProtectionMiddleware(
  devices: Pick<DeviceService, "requiresEncryptedStorage">,
  protection: () => GatewayStorageProtection | undefined,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    // Identity and current protection remain readable so a client can explain
    // the refusal. These endpoints return no corpus contents or credentials.
    if (
      auth &&
      c.req.path !== "/health" &&
      c.req.path !== "/whoami" &&
      devices.requiresEncryptedStorage(auth) &&
      protection()?.atRest !== "encrypted"
    ) {
      c.header("Retry-After", "5");
      throw new HttpError(
        503,
        "STORAGE_PROTECTION_REQUIRED",
        "Protect this library's storage on its home computer before using this device.",
      );
    }
    return next();
  };
}
