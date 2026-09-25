// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { WEB_SOURCE_ID } from "../../web-dataset.js";
import { BadRequestError } from "../errors.js";
import { enforceWriteScopeForSourceType, scope } from "../scope.js";
import { validateJson } from "../validate.js";
import {
  addExcludedDomainBody,
  excludedDomainParam,
  setCapturePauseBody,
} from "../schemas/index.js";
import type { WebCapturePolicyService } from "../../sources/web/capture-policy.js";
import type { RouteApp } from "./types.js";

/**
 * The capture policy the browser extension reads and edits.
 *
 * Every route is reachable with the browser's own `write:web` token (and by an
 * operator identity): the policy is the push contract of the source that token
 * writes, not corpus data, so the token that may add pages may also say which
 * pages must never be added. Each edit is a self-contained operation — add or
 * remove one domain, set or clear the pause — applied on the service's edit
 * lane, so two browsers editing at once never overwrite each other, and every
 * response carries the whole policy so the caller's cache is current without a
 * second round trip.
 */
export function mountWebCapturePolicyRoutes(app: RouteApp, policy: WebCapturePolicyService): void {
  app.get("/web-capture-policy", scope.writeAny(), (c) => {
    enforceWriteScopeForSourceType(c.get("auth").scopes, WEB_SOURCE_ID);
    return c.json(policy.read());
  });

  app.post(
    "/web-capture-policy/excluded-domains",
    scope.writeAny(),
    validateJson(addExcludedDomainBody),
    async (c) => {
      const auth = c.get("auth");
      enforceWriteScopeForSourceType(auth.scopes, WEB_SOURCE_ID);
      const { domain, purge } = c.req.valid("json");
      return c.json(await policy.addExcludedDomain(domain, auth, purge === true));
    },
  );

  app.delete("/web-capture-policy/excluded-domains/:domain", scope.writeAny(), async (c) => {
    const auth = c.get("auth");
    enforceWriteScopeForSourceType(auth.scopes, WEB_SOURCE_ID);
    const raw = excludedDomainParam.safeParse(c.req.param("domain"));
    if (!raw.success) throw new BadRequestError("Not a valid domain");
    return c.json(await policy.removeExcludedDomain(raw.data, auth));
  });

  app.put(
    "/web-capture-policy/pause",
    scope.writeAny(),
    validateJson(setCapturePauseBody),
    async (c) => {
      const auth = c.get("auth");
      enforceWriteScopeForSourceType(auth.scopes, WEB_SOURCE_ID);
      return c.json(await policy.setPause(c.req.valid("json").until, auth));
    },
  );

  app.delete("/web-capture-policy/pause", scope.writeAny(), async (c) => {
    const auth = c.get("auth");
    enforceWriteScopeForSourceType(auth.scopes, WEB_SOURCE_ID);
    return c.json(await policy.clearPause(auth));
  });
}
