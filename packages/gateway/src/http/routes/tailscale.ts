// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway's own tailnet device: the owner's controls (admin routes) and
 * the routes a collector on the owner's tailnet uses to join without a
 * pairing code. None of them exist without OMNESIS_TAILSCALE_EMBED_ENABLED=1.
 *
 * Every owner action that loosens the gateway asks for a step-up where the
 * gateway requires one (see step-up.ts): turning the device on or signing it
 * in (whoever completes the sign-in chooses the tailnet), opening the public
 * address, joining automatically, and approving a request. Turning it off,
 * signing it out, asking first, switching joining off and denying never do.
 * Step-up applies only where the cloud relay opt-in and a confirmed passkey
 * make the gateway require it; otherwise these guards pass every request.
 */

import { assertNever, tailscaleEmbedEnabled, tailscaleJoinPolicySchema } from "@omnesis/core";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { IpRateLimiter } from "../../rate-limit.js";
import { tailnetCallerAddress, tailnetCallerOfEnv } from "../../tailscale-embed/caller.js";
import { deviceNameSchema } from "../../tailscale-embed/settings.js";
import { deviceCapabilitySchema } from "../schemas/common.js";
import { scope } from "../scope.js";
import { declines, requireStepUp } from "../step-up.js";
import { validateJson } from "../validate.js";
import type { TailscaleEmbedService } from "../../tailscale-embed/service.js";
import type { DeviceCapability } from "@omnesis/types";
import type { Context } from "hono";
import type { AppEnv, RouteApp } from "./types.js";

const enableBody = z.object({ enabled: z.boolean() }).strict();
const settingsBody = z
  .object({
    publicAccess: z.boolean().optional(),
    joinPolicy: tailscaleJoinPolicySchema.optional(),
    deviceName: deviceNameSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to change." });
const decisionBody = z.object({ approve: z.boolean() }).strict();
const joinName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u,
    "Use letters, digits, spaces, dots, hyphens and apostrophes.",
  );
const joinBody = z
  .object({ name: joinName.optional(), capabilities: deviceCapabilitySchema.optional() })
  .strict();
const pollBody = z.object({ secret: z.string().min(16).max(128) }).strict();

/** Turning the device off only closes the gateway. */
const turnsOff = (body: unknown): boolean =>
  (body as { enabled?: unknown } | null | undefined)?.enabled === false;
/** A settings change that opens nothing: no public address, no automatic joins. */
const opensNothing = (body: unknown): boolean => {
  const settings = body as { publicAccess?: unknown; joinPolicy?: unknown } | null | undefined;
  return settings?.publicAccess !== true && settings?.joinPolicy !== "automatic";
};

function notFromTailnet(c: Context<AppEnv>) {
  return c.json(
    {
      code: "not-tailnet",
      error:
        "Joining through Tailscale works only from a device on the gateway owner's Tailscale network.",
    },
    403,
  );
}

function tooMany(c: Context<AppEnv>, error: string, retryAfter: string) {
  return c.json({ code: "too-many-requests", error }, 429, { "Retry-After": retryAfter });
}

export function mountTailscaleRoutes(app: RouteApp, service?: TailscaleEmbedService): void {
  if (!tailscaleEmbedEnabled() || !service) return;
  const bounded = bodyLimit({ maxSize: 16_384 });
  const noStore: Parameters<RouteApp["use"]>[1] = async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  };
  app.use("/admin/tailscale*", noStore);
  app.use("/tailscale/*", noStore);

  app.get("/admin/tailscale", scope.admin(), (c) => c.json(service.state()));
  app.post(
    "/admin/tailscale/enable",
    scope.admin(),
    bounded,
    requireStepUp(turnsOff),
    validateJson(enableBody),
    async (c) => c.json(await service.setEnabled(c.req.valid("json").enabled)),
  );
  app.post("/admin/tailscale/sign-in", scope.admin(), requireStepUp(), (c) =>
    c.json(service.signIn()),
  );
  app.post("/admin/tailscale/sign-out", scope.admin(), (c) => c.json(service.signOut()));
  app.patch(
    "/admin/tailscale/settings",
    scope.admin(),
    bounded,
    requireStepUp(opensNothing),
    validateJson(settingsBody),
    async (c) => c.json(await service.updateSettings(c.req.valid("json"))),
  );
  app.get("/admin/tailscale/join-requests", scope.admin(), (c) =>
    c.json({ requests: service.joins.list() }),
  );
  app.post(
    "/admin/tailscale/join-requests/:id/decision",
    scope.admin(),
    bounded,
    requireStepUp(declines),
    validateJson(decisionBody),
    (c) => {
      const approve = c.req.valid("json").approve;
      if (!service.joins.decide(c.req.param("id"), approve)) {
        return c.json(
          { code: "join-request-gone", error: "This request has expired or was already decided." },
          404,
        );
      }
      return c.json({ status: approve ? "approved" : "denied" });
    },
  );

  const joinLimiter = new IpRateLimiter({
    surface: "/tailscale/join",
    burst: { capacity: 6, windowMs: 60_000 },
    hourly: { capacity: 60, windowMs: 3_600_000 },
  });
  const pollLimiter = new IpRateLimiter({
    surface: "/tailscale/join/poll",
    burst: { capacity: 30, windowMs: 60_000 },
    hourly: { capacity: 600, windowMs: 3_600_000 },
  });

  app.post("/tailscale/join", scope.public(), bounded, validateJson(joinBody), async (c) => {
    const caller = tailnetCallerOfEnv(c.env);
    if (caller?.via !== "tailnet") return notFromTailnet(c);
    if (joinLimiter.consume(tailnetCallerAddress(caller))) {
      return tooMany(c, "Too many join attempts — try again later.", "60");
    }
    const body = c.req.valid("json");
    const outcome = await service.joins.request({
      peer: caller.peer,
      policy: service.joinPolicy(),
      ...(body.name ? { name: body.name } : {}),
      capabilities: (body.capabilities ?? {}) as DeviceCapability,
    });
    switch (outcome.status) {
      case "joined":
        return c.json({ status: "joined", ...outcome.credentials });
      case "pending":
        return c.json(outcome, 202);
      case "refused":
        return c.json(
          { code: outcome.code, error: outcome.message },
          outcome.code === "too-many-requests" ? 429 : outcome.code === "join-failed" ? 409 : 403,
        );
      default:
        return assertNever(outcome);
    }
  });

  app.post(
    "/tailscale/join/:id/poll",
    scope.public(),
    bounded,
    validateJson(pollBody),
    async (c) => {
      const caller = tailnetCallerOfEnv(c.env);
      if (caller?.via !== "tailnet") return notFromTailnet(c);
      if (pollLimiter.consume(tailnetCallerAddress(caller))) {
        return tooMany(c, "Checking too often — slow down.", "10");
      }
      const outcome = await service.joins.poll({
        id: c.req.param("id"),
        secret: c.req.valid("json").secret,
        peer: caller.peer,
      });
      switch (outcome.status) {
        case "pending":
          return c.json(outcome, 202);
        case "joined":
          return c.json({ status: "joined", ...outcome.credentials });
        case "denied":
          return c.json({ status: "denied", error: "The gateway owner denied this request." }, 403);
        case "failed":
          return c.json({ status: "failed", error: outcome.message }, 409);
        case "gone":
          return c.json(
            { status: "gone", error: "This request has expired or is unknown. Ask to join again." },
            404,
          );
        default:
          return assertNever(outcome);
      }
    },
  );
}
