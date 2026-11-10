// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Admin routes for setting up the Decision model:
 *
 *   POST   /admin/inference/decision-backends/probe        {url, …} models a server not yet saved has
 *   POST   /admin/inference/decision-backends/:key/probe   models a saved backend's server has
 *   POST   /admin/inference/decision-backends/:key/verify  {model} → one test decision
 *   POST   /admin/inference/typesafe/verify                 {model} → the same, for TypeSafe
 *   GET    /admin/models/decision/calibration               the calibration job's status
 *   POST   /admin/models/decision/calibration               start calibrating the assigned model
 *   DELETE /admin/models/decision/calibration               cancel it
 *
 * Adding, removing and assigning decision backends goes through
 * `PATCH /admin/config` like every other backend, so the key in the body is
 * moved into the secret store on the way in.
 */

import { BadRequestError, ConflictError, NotFoundError } from "../http/errors.js";
import { decisionModelBody, decisionProbeBody } from "../http/schemas/decision.js";
import { scope } from "../http/scope.js";
import { validateJson } from "../http/validate.js";
import {
  CalibrationConflict,
  CalibrationUnsupported,
  probeDecisionBackend,
  type DecisionCalibrationJob,
} from "./decision-tools.js";
import type { RouteApp } from "../http/routes/types.js";
import type { ResolvedDecisionBackendConfig } from "../inference/registry.js";
import type { DecisionClients } from "../inference/decision/decision-clients.js";
import type { ResolvedAssignment } from "@omnesis/core";

export interface DecisionRouteOptions {
  allowRemoteInference: () => boolean;
  getDecisionBackend: (key: string) => ResolvedDecisionBackendConfig | undefined;
  /** Resolve `<key>/<model>` (decision backend) or `typesafe/<model>` for the decision role. */
  resolveDecision: (assignment: string) => ResolvedAssignment;
  clients: DecisionClients;
  calibration: DecisionCalibrationJob;
  fetchFn?: typeof fetch;
}

export function registerDecisionRoutes(app: RouteApp, opts: DecisionRouteOptions): void {
  const backendOr404 = (key: string): ResolvedDecisionBackendConfig => {
    const cfg = opts.getDecisionBackend(key);
    if (!cfg) throw new NotFoundError(`unknown decision backend: ${key}`);
    return cfg;
  };

  app.post(
    "/admin/inference/decision-backends/probe",
    scope.admin(),
    validateJson(decisionProbeBody),
    async (c) =>
      c.json(
        await probeDecisionBackend(c.req.valid("json"), opts.allowRemoteInference(), opts.fetchFn),
      ),
  );

  app.post("/admin/inference/decision-backends/:key/probe", scope.admin(), async (c) => {
    const cfg = backendOr404(c.req.param("key"));
    return c.json(await probeDecisionBackend(cfg, opts.allowRemoteInference(), opts.fetchFn));
  });

  app.post(
    "/admin/inference/decision-backends/:key/verify",
    scope.admin(),
    validateJson(decisionModelBody),
    async (c) => {
      const key = c.req.param("key");
      backendOr404(key);
      const { model } = c.req.valid("json");
      return c.json(await opts.clients.verify(opts.resolveDecision(`${key}/${model}`)));
    },
  );

  app.post(
    "/admin/inference/typesafe/verify",
    scope.admin(),
    validateJson(decisionModelBody),
    async (c) => {
      const { model } = c.req.valid("json");
      return c.json(await opts.clients.verify(opts.resolveDecision(`typesafe/${model}`)));
    },
  );

  app.get("/admin/models/decision/calibration", scope.admin(), (c) =>
    c.json(opts.calibration.status()),
  );

  app.post("/admin/models/decision/calibration", scope.admin(), (c) => {
    try {
      return c.json(opts.calibration.start(), 202);
    } catch (err) {
      if (err instanceof CalibrationConflict) throw new ConflictError(err.message);
      if (err instanceof CalibrationUnsupported) throw new BadRequestError(err.message);
      throw err;
    }
  });

  app.delete("/admin/models/decision/calibration", scope.admin(), (c) =>
    c.json(opts.calibration.cancel()),
  );
}
