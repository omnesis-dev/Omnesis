// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { cloudRelayEnabled } from "@omnesis/core";
import { bodyLimit } from "hono/body-limit";
import { CloudRelayManagementFailure } from "@omnesis/cloud-relay";
import { scope } from "../../scope.js";
import { validateJson } from "../../validate.js";
import {
  cloudRelayConfigureBody,
  cloudRelayEnableBody,
  cloudRelayActionBody,
  cloudRelayEnrollmentBody,
  cloudRelayConnectBody,
} from "../../schemas/cloud-relay.js";
import type { CloudRelayManagement } from "@omnesis/cloud-relay";
import type { Context } from "hono";
import type { AppEnv, RouteApp } from "../types.js";

export function mountCloudRelayManagementRoutes(
  app: RouteApp,
  service?: CloudRelayManagement,
): void {
  if (!cloudRelayEnabled() || !service) return;
  app.use("/admin/cloud-relay*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  const bounded = bodyLimit({ maxSize: 16_384 });
  app.get("/admin/cloud-relay", scope.admin(), async (c) =>
    respond(c, async () => {
      // Only this read asks the relay; other callers of status() never reach the network.
      await service.refreshSignupAccess?.();
      return service.status();
    }),
  );
  app.post(
    "/admin/cloud-relay/configure",
    scope.admin(),
    bounded,
    validateJson(cloudRelayConfigureBody),
    async (c) => respond(c, () => service.configure(c.req.valid("json"))),
  );
  app.post(
    "/admin/cloud-relay/enable",
    scope.admin(),
    bounded,
    validateJson(cloudRelayEnableBody),
    async (c) => respond(c, () => service.enable(c.req.valid("json"))),
  );
  app.post(
    "/admin/cloud-relay/account/link",
    scope.admin(),
    bounded,
    validateJson(cloudRelayActionBody),
    async (c) =>
      respond(c, async () => {
        if (!service.accountLink) throw new CloudRelayManagementFailure(503, "account-unavailable");
        const result = await service.accountLink({ requestOrigin: new URL(c.req.url).origin });
        c.header("Set-Cookie", result.cookie);
        return { authorizeUrl: result.authorizeUrl };
      }),
  );
  app.post(
    "/admin/cloud-relay/account/unlink",
    scope.admin(),
    bounded,
    validateJson(cloudRelayActionBody),
    async (c) =>
      respond(c, async () => {
        if (!service.accountUnlink)
          throw new CloudRelayManagementFailure(503, "account-unavailable");
        return service.accountUnlink();
      }),
  );
  app.post(
    "/admin/cloud-relay/connect",
    scope.admin(),
    bounded,
    validateJson(cloudRelayConnectBody),
    async (c) =>
      respond(c, async () => {
        if (!service.connect) throw new CloudRelayManagementFailure(503, "account-unavailable");
        return service.connect(c.req.valid("json"));
      }),
  );
  app.post(
    "/admin/cloud-relay/connect/cancel",
    scope.admin(),
    bounded,
    validateJson(cloudRelayActionBody),
    async (c) =>
      respond(c, async () => {
        if (!service.cancelConnect)
          throw new CloudRelayManagementFailure(503, "account-unavailable");
        return service.cancelConnect();
      }),
  );
  app.put(
    "/admin/cloud-relay/enrollment",
    scope.admin(),
    bounded,
    validateJson(cloudRelayEnrollmentBody),
    async (c) =>
      respond(c, async () => {
        if (!service.setEnrollmentPolicy)
          throw new CloudRelayManagementFailure(503, "account-unavailable");
        return service.setEnrollmentPolicy(c.req.valid("json").policy);
      }),
  );
  app.delete("/admin/cloud-relay/trusted-sign-ins/:id", scope.admin(), async (c) =>
    respond(c, async () => {
      if (!service.removeTrustedSignIn)
        throw new CloudRelayManagementFailure(503, "account-unavailable");
      return service.removeTrustedSignIn(c.req.param("id"));
    }),
  );
  app.get("/admin/cloud-relay/account/callback", scope.admin(), async (c) => {
    try {
      if (!service.accountCallback)
        throw new CloudRelayManagementFailure(503, "account-unavailable");
      const result = await service.accountCallback({
        url: c.req.url,
        cookie: c.req.header("cookie"),
      });
      c.header("Set-Cookie", result.cookie);
      return c.redirect(result.redirectUrl);
    } catch (error) {
      return failure(c, error);
    }
  });
  app.post(
    "/admin/cloud-relay/google/link",
    scope.admin(),
    bounded,
    validateJson(cloudRelayActionBody),
    async (c) =>
      respond(c, async () => {
        if (!service.googleLink) throw new CloudRelayManagementFailure(503, "google-unavailable");
        const result = await service.googleLink({ requestOrigin: new URL(c.req.url).origin });
        c.header("Set-Cookie", result.cookie);
        return { authorizeUrl: result.authorizeUrl };
      }),
  );
  app.post(
    "/admin/cloud-relay/google/unlink",
    scope.admin(),
    bounded,
    validateJson(cloudRelayActionBody),
    async (c) =>
      respond(c, async () => {
        if (!service.googleUnlink) throw new CloudRelayManagementFailure(503, "google-unavailable");
        return service.googleUnlink();
      }),
  );
  app.get("/admin/cloud-relay/google/callback", scope.admin(), async (c) => {
    try {
      if (!service.googleCallback) throw new CloudRelayManagementFailure(503, "google-unavailable");
      const result = await service.googleCallback({
        url: c.req.url,
        cookie: c.req.header("cookie"),
      });
      c.header("Set-Cookie", result.cookie);
      return c.redirect(result.redirectUrl);
    } catch (error) {
      return failure(c, error);
    }
  });
  for (const operation of ["disable", "reconnect", "renew"] as const) {
    app.post(
      `/admin/cloud-relay/${operation}`,
      scope.admin(),
      bounded,
      validateJson(cloudRelayActionBody),
      async (c) => respond(c, () => service[operation]()),
    );
  }
}

async function respond(
  c: Context<AppEnv>,
  operation: () => Promise<
    import("@omnesis/cloud-relay").CloudRelayManagementStatus | { authorizeUrl: string }
  >,
) {
  try {
    return c.json(await operation());
  } catch (error) {
    return failure(c, error);
  }
}

function failure(c: Context<AppEnv>, error: unknown) {
  if (error instanceof CloudRelayManagementFailure)
    return c.json({ error: "Relay operation was refused.", code: error.code }, error.status);
  return c.json(
    { error: "Relay management is unavailable. Try again.", code: "relay-management-unavailable" },
    503,
  );
}
