// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Admin routes for setting up the Decision model:
 *
 *   POST   /admin/inference/decision/probe                 {url, …} models an unsaved decision API has
 *   POST   /admin/inference/backends/:key/decision/probe   models a backend's decision API has
 *   POST   /admin/inference/backends/:key/decision/verify  {model} → one test decision
 *   POST   /admin/inference/typesafe/verify                 {model} → the same, for TypeSafe
 *
 * Adding a backend's decision API, removing it and assigning one of its
 * models go through `PATCH /admin/config` like every other backend change
 * (`inference.backends.<key>.decision`), so a key in the body is moved into
 * the secret store on the way in.
 */

import { NotFoundError } from "../http/errors.js";
import { decisionModelBody, decisionProbeBody } from "../http/schemas/decision.js";
import { scope } from "../http/scope.js";
import { validateJson } from "../http/validate.js";
import { probeDecisionBackend } from "./decision-tools.js";
import type { RouteApp } from "../http/routes/types.js";
import type { DecisionEndpointConfig } from "../inference/registry.js";
import type { DecisionClients } from "../inference/decision/decision-clients.js";
import type { ResolvedAssignment } from "@omnesis/core";

export interface DecisionRouteOptions {
  allowRemoteInference: () => boolean;
  getDecisionEndpoint: (key: string) => DecisionEndpointConfig | undefined;
  /** Whether a backend of that name is configured. */
  hasBackend: (key: string) => boolean;
  /** A configured backend's API key, when it has one. */
  getBackendApiKey: (key: string) => string | undefined;
  /** Resolve `<key>/<model>` (a backend's decision API) or `typesafe/<model>` for the decision role. */
  resolveDecision: (assignment: string) => ResolvedAssignment;
  clients: DecisionClients;
  fetchFn?: typeof fetch;
}

export function registerDecisionRoutes(app: RouteApp, opts: DecisionRouteOptions): void {
  const endpointOr404 = (key: string): DecisionEndpointConfig => {
    const cfg = opts.getDecisionEndpoint(key);
    if (!cfg) throw new NotFoundError(`backend "${key}" has no decision API`);
    return cfg;
  };

  app.post(
    "/admin/inference/decision/probe",
    scope.admin(),
    validateJson(decisionProbeBody),
    async (c) => {
      const { backendKey, ...target } = c.req.valid("json");
      if (backendKey !== undefined && target.apiKey === undefined) {
        if (!opts.hasBackend(backendKey)) throw new NotFoundError(`unknown backend: ${backendKey}`);
        const apiKey = opts.getBackendApiKey(backendKey);
        if (apiKey) target.apiKey = apiKey;
      }
      return c.json(await probeDecisionBackend(target, opts.allowRemoteInference(), opts.fetchFn));
    },
  );

  app.post("/admin/inference/backends/:key/decision/probe", scope.admin(), async (c) => {
    const cfg = endpointOr404(c.req.param("key"));
    return c.json(await probeDecisionBackend(cfg, opts.allowRemoteInference(), opts.fetchFn));
  });

  app.post(
    "/admin/inference/backends/:key/decision/verify",
    scope.admin(),
    validateJson(decisionModelBody),
    async (c) => {
      const key = c.req.param("key");
      endpointOr404(key);
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
}
