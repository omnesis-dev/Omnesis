// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { cloudRelayEnabled } from "@omnesis/core";
import { bodyLimit } from "hono/body-limit";
import { CloudRelayManagementFailure } from "@omnesis/cloud-relay";
import { scope } from "../../scope.js";
import { validateJson, validateQuery } from "../../validate.js";
import { arrivedThroughRelay } from "../../client-ip.js";
import { requireStepUp } from "../../step-up.js";
import {
  cloudRelayConfigureBody,
  cloudRelayEnableBody,
  cloudRelayActionBody,
  cloudRelayEnrollmentBody,
  cloudRelayConnectBody,
  cloudRelayRemoveSignInQuery,
  cloudRelayConfirmPasskeyBody,
} from "../../schemas/cloud-relay.js";
import type { CloudRelayManagement } from "@omnesis/cloud-relay";
import type { Context } from "hono";
import type { AppEnv, RouteApp } from "../types.js";

export function mountCloudRelayManagementRoutes(
  app: RouteApp,
  service?: CloudRelayManagement,
  devices?: {
    /** Revokes the live devices that joined with this sign-in and returns their ids. */
    revokeJoinedWith(signInId: string): Promise<string[]>;
  },
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
    // Choosing automatic joins needs a step-up; "ask me first" never does.
    requireStepUp((body) => (body as { policy?: unknown } | null)?.policy === "ask"),
    validateJson(cloudRelayEnrollmentBody),
    async (c) =>
      respond(c, async () => {
        if (!service.setEnrollmentPolicy)
          throw new CloudRelayManagementFailure(503, "account-unavailable");
        return service.setEnrollmentPolicy(c.req.valid("json").policy);
      }),
  );
  app.post(
    "/admin/cloud-relay/incidents/ack",
    scope.admin(),
    bounded,
    validateJson(cloudRelayActionBody),
    async (c) => {
      // While someone else may hold a certificate for the gateway's name, a relayed request may
      // come from a page posing as the gateway, so only the owner on the gateway itself may lift
      // the hold: the local CLI, or an admin request that didn't come through the relay.
      if (arrivedThroughRelay((name) => c.req.header(name), c.env))
        return c.json(
          {
            error:
              "Certificate incidents can only be acknowledged on the gateway itself: run `omnesis cloud incidents ack` on the gateway host.",
            code: "local-request-required",
          },
          403,
        );
      return respond(c, async () => {
        if (!service.acknowledgeIncidentHold)
          throw new CloudRelayManagementFailure(503, "account-unavailable");
        return service.acknowledgeIncidentHold();
      });
    },
  );
  app.delete(
    "/admin/cloud-relay/trusted-sign-ins/:id",
    scope.admin(),
    validateQuery(cloudRelayRemoveSignInQuery),
    async (c) =>
      respond(c, async () => {
        if (!service.removeTrustedSignIn || !devices)
          throw new CloudRelayManagementFailure(503, "account-unavailable");
        const id = c.req.param("id");
        // The sign-in goes first, so no device can join with it while its devices are revoked.
        const status = await service.removeTrustedSignIn(id);
        if (c.req.valid("query").revokeDevices !== "true") return status;
        return { ...status, revokedDevices: await devices.revokeJoinedWith(id) };
      }),
  );
  // The sign-ins this gateway trusts, where each came from and whether the owner confirmed it
  // here. Read-only: the same facts as the status, listed for the portal and the CLI.
  app.get("/admin/cloud-relay/trusted-sign-ins", scope.admin(), async (c) =>
    respond(c, async () => {
      const enrollment = (await service.status()).deviceEnrollment;
      if (!enrollment) throw new CloudRelayManagementFailure(503, "account-unavailable");
      const pinned = new Set(enrollment.trustedSignIns.map(({ type, id }) => `${type}:${id}`));
      return {
        items: [
          ...enrollment.trustedSignIns.map((signIn) => ({
            ...signIn,
            via: enrollment.confirmedSignIns.find(
              ({ type, id }) => type === signIn.type && id === signIn.id,
            )?.via,
          })),
          ...enrollment.confirmedSignIns
            .filter(({ type, id }) => !pinned.has(`${type}:${id}`))
            .map(({ type, id, at, via }) => ({ type, id, addedAt: at, confirmed: true, via })),
        ],
        ...(enrollment.confirmOrigin ? { confirmOrigin: enrollment.confirmOrigin } : {}),
      };
    }),
  );
  // Confirming a passkey runs on the gateway's own page: options, then the assertion.
  app.post(
    "/admin/cloud-relay/passkeys/confirm/options",
    scope.admin(),
    bounded,
    validateJson(cloudRelayActionBody),
    async (c) =>
      respond(c, async () => {
        if (!service.passkeyConfirmation)
          throw new CloudRelayManagementFailure(503, "account-unavailable");
        return service.passkeyConfirmation();
      }),
  );
  app.post(
    "/admin/cloud-relay/passkeys/confirm",
    scope.admin(),
    bounded,
    // Once one passkey is confirmed, confirming another needs a step-up with it.
    requireStepUp(),
    validateJson(cloudRelayConfirmPasskeyBody),
    async (c) =>
      respond(c, async () => {
        if (!service.confirmPasskey)
          throw new CloudRelayManagementFailure(503, "account-unavailable");
        return service.confirmPasskey(c.req.valid("json").proof);
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

async function respond(c: Context<AppEnv>, operation: () => Promise<object>) {
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
