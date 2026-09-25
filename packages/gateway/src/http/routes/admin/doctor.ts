// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `GET /admin/doctor` — the gateway's self-diagnosis, in the same shape
 * `omnesis doctor --json` prints.
 *
 * The route is deliberately thin: `DoctorService` gathers the state and the
 * shared evaluator in `@omnesis/core/doctor` classifies it, so this file
 * only resolves the caller's identity (the auth section describes whoever
 * asked) and serves the result.
 */

import { tryDeviceId, type DeviceId } from "@omnesis/types";
import { scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import { BadRequestError } from "../../errors.js";
import { fleetDeviceSelectionBody } from "../../schemas/index.js";
import type { RouteApp } from "../types.js";
import type { AdminRoutesDeps } from "./internals.js";

/**
 * Block 1.16 — operator diagnostics.
 *
 *   GET  /admin/doctor
 *   GET  /admin/fleet/doctor
 *   POST /admin/fleet/doctor
 */
export function mountDoctorRoutes(app: RouteApp, deps: AdminRoutesDeps): void {
  const { deviceService, doctorService, deviceDoctorService } = deps;

  app.get("/admin/doctor", scope.admin(), async (c) => {
    return c.json(await doctorService.report(deviceService.resolveWhoAmI(c.get("auth"))));
  });

  app.get("/admin/fleet/doctor", scope.admin(), (c) => c.json(deviceDoctorService.list()));

  app.post(
    "/admin/fleet/doctor",
    scope.admin(),
    validateJson(fleetDeviceSelectionBody),
    async (c) => {
      const ids = c.req.valid("json").deviceIds?.map((raw): DeviceId => {
        const id = tryDeviceId(raw);
        if (!id) throw new BadRequestError(`invalid device id: ${raw}`);
        return id;
      });
      try {
        return c.json(await deviceDoctorService.request(ids));
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("No such device:")) {
          throw new BadRequestError(err.message);
        }
        throw err;
      }
    },
  );
}
