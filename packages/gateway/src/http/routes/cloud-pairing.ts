// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { cloudRelayEnabled } from "@omnesis/core";
import { defaultScopesForDeviceKind } from "@omnesis/types";
import { googlePairingRequestSchema } from "@omnesis/cloud-relay";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { CloudPairingRuntime } from "../services/CloudPairingRuntime.js";
import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import { IpRateLimiter, pairingRateLimiter } from "../../rate-limit.js";
import { HttpError } from "../errors.js";
import { webGooglePairingRequest } from "../services/WebGooglePairing.js";
import {
  cloudPairingIdentity,
  webGooglePairingConfiguration,
} from "../services/CloudPairingConfiguration.js";
import { clientIp } from "./admin/internals.js";
import type { RouteApp } from "./types.js";
import type { WriteGate } from "../../write-gate.js";
import type { CloudPairingIdentity } from "../services/CloudPairingConfiguration.js";

/** Optional identity discovery never replaces the gateway's device/grant approval. */
export function mountCloudPairingRoutes(
  app: RouteApp,
  write: WriteGate,
  fingerprint: () => string,
  options?: {
    identity: import("@omnesis/cloud-relay").IdentityProvider;
    ownerAccountId: string;
  },
  publicBaseUrl?: string,
  identitySource?: () => CloudPairingIdentity | undefined,
  publicOriginSource?: () => string | undefined,
  broker?: () => import("@omnesis/cloud-relay").GoogleBrowserPort | undefined,
  account?: ConstructorParameters<typeof CloudPairingRuntime>[0]["account"],
  onPending?: ConstructorParameters<typeof CloudPairingRuntime>[0]["onPending"],
  spkiFingerprint?: () => string | undefined,
  revokedDeviceKey?: ConstructorParameters<typeof CloudPairingRuntime>[0]["revokedDeviceKey"],
): void {
  if (!cloudRelayEnabled()) return;
  const clientId = process.env.OMNESIS_CLOUD_RELAY_GOOGLE_CLIENT_ID;
  const webClientId = process.env.OMNESIS_CLOUD_RELAY_GOOGLE_WEB_CLIENT_ID;
  const initial = identitySource ? undefined : cloudPairingIdentity(process.env, options);
  if (!identitySource && !initial && !account) return;
  const runtime = new CloudPairingRuntime({
    identity: identitySource ?? (() => initial),
    broker,
    account,
    onPending,
    revokedDeviceKey,
    publicOrigin: publicOriginSource ?? (() => publicBaseUrl),
    webConfiguration: (origin) =>
      webGooglePairingConfiguration(
        publicOriginSource
          ? { ...process.env, OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: undefined }
          : process.env,
        origin,
      ),
    fingerprint,
    createPairing: async (request) =>
      write.createPairing({
        kind: request.kind,
        name: request.name,
        scopes: defaultScopesForDeviceKind(request.kind),
        ttlMs: Math.max(1, request.expiresAt - Date.now()),
        ...(request.enrollment ? { enrollment: request.enrollment } : {}),
      }),
  });
  if (!identitySource) runtime.resolve();
  const current = () => {
    const active = runtime.resolve();
    if (!active)
      throw new HttpError(404, "CLOUD_PAIRING_UNAVAILABLE", "Google pairing is not configured");
    return active;
  };
  const currentWeb = () => {
    const active = current();
    if (!active.web)
      throw new HttpError(404, "CLOUD_PAIRING_UNAVAILABLE", "Google web pairing is not configured");
    return { web: active.web, origin: active.webOrigin, account: active.account };
  };
  for (const base of ["/devices/google", "/devices/account"])
    app.get(`${base}/config`, scope.public(), (c) => {
      c.header("Cache-Control", "no-store");
      const active = current();
      return c.json({
        clientId:
          webClientId ??
          broker?.()?.clientId("device-enrollment") ??
          clientId?.split(",")[0]?.trim() ??
          "",
        gatewayFingerprint: fingerprint(),
        webSignIn: Boolean(active.web),
        ...(active.account ? { accountSignIn: true } : {}),
        ...(active.account && spkiFingerprint?.()
          ? { automaticEnrollment: true, gatewaySpkiFingerprint: spkiFingerprint() }
          : {}),
        ...(active.managedClient
          ? {
              authorizationRelayOrigin: active.account
                ? account?.().broker?.authorizationOrigin()
                : broker?.()?.authorizationOrigin?.(),
            }
          : {}),
        ...(active.webOrigin ? { webOrigin: active.webOrigin } : {}),
      });
    });
  const limiter = pairingRateLimiter();
  const pollLimiter = new IpRateLimiter({
    surface: "/devices/google/poll",
    burst: { capacity: 120, windowMs: 60_000 },
    hourly: { capacity: 3600, windowMs: 3_600_000 },
  });
  const poll = z
    .object({ requestId: z.string().uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict();
  const boundedBody = bodyLimit({
    maxSize: 20_000,
    onError: (c) =>
      c.json({ error: "Google pairing request body too large", code: "PAYLOAD_TOO_LARGE" }, 413),
  });
  const safe = async <T>(run: () => T | Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      const status =
        typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
      throw new HttpError(
        typeof status === "number" && [403, 404, 409, 429].includes(status) ? status : 401,
        "CLOUD_PAIRING_REFUSED",
        "Cloud pairing request refused",
      );
    }
  };
  const operate = async <T>(
    run: (active: NonNullable<ReturnType<CloudPairingRuntime["resolve"]>>) => T | Promise<T>,
  ): Promise<T> =>
    safe(async () => {
      const active = current();
      const result = await run(active);
      if (runtime.resolve() !== active)
        throw new HttpError(
          409,
          "CLOUD_PAIRING_CHANGED",
          "Google pairing identity changed; start again",
        );
      return result;
    });
  for (const base of ["/devices/google", "/devices/account"]) {
    // `__Host-` binds the sign-in state to this exact origin: unlike a
    // `__Secure-` cookie, no sibling under the same parent domain can plant
    // one alongside it. The prefix requires `Path=/` and no `Domain`.
    const cookieName =
      base === "/devices/account" ? "__Host-omnesis-account-login" : "__Host-omnesis-google-login";
    if (
      account ||
      broker ||
      (webClientId && process.env.OMNESIS_CLOUD_RELAY_GOOGLE_WEB_SECRET_FILE)
    ) {
      app.post(
        `${base}/authorize`,
        scope.public(),
        boundedBody,
        validateJson(webGooglePairingRequest),
        async (c) => {
          const { web: authorizations, origin: fixedOrigin, account: usesAccount } = currentWeb();
          if (Boolean(usesAccount) !== (base === "/devices/account"))
            throw new HttpError(
              404,
              "CLOUD_PAIRING_UNAVAILABLE",
              "Account pairing route unavailable",
            );
          const origin = fixedOrigin ?? new URL(c.req.url).origin;
          if (c.req.header("Origin") !== origin)
            throw new HttpError(
              403,
              "CLOUD_PAIRING_REFUSED",
              "Same-origin Google sign-in required",
            );
          if (limiter.consume(clientIp(c)))
            return c.json({ error: "Too many pairing requests" }, 429);
          c.header("Cache-Control", "no-store");
          const authorization = await operate(() =>
            authorizations.begin(c.req.valid("json"), origin),
          );
          const state =
            authorization.browserState ??
            new URL(authorization.authorizationUrl).searchParams.get("state")!;
          c.header(
            "Set-Cookie",
            `${cookieName}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
          );
          return c.json({ authorizationUrl: authorization.authorizationUrl });
        },
      );
      app.get(`${base}/callback`, scope.public(), async (c) => {
        c.header("Cache-Control", "no-store");
        c.header("Referrer-Policy", "no-referrer");
        c.header("Set-Cookie", `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
        try {
          const { web: authorizations, origin: fixedOrigin, account: usesAccount } = currentWeb();
          if (Boolean(usesAccount) !== (base === "/devices/account"))
            throw new HttpError(
              404,
              "CLOUD_PAIRING_UNAVAILABLE",
              "Account pairing route unavailable",
            );
          const origin = fixedOrigin ?? new URL(c.req.url).origin;
          const callback = new URL(`${base}/callback`, origin);
          callback.search = new URL(c.req.url).search;
          const cookies = (c.req.header("Cookie") ?? "")
            .split(";")
            .map((part) => part.trim())
            .filter((part) => part.startsWith(cookieName + "="))
            .map((part) => part.slice(cookieName.length + 1));
          const requestId = await operate(() =>
            authorizations.complete(callback.href, cookies.length === 1 ? cookies[0]! : ""),
          );
          return c.redirect(`/portal/?googlePairing=${encodeURIComponent(requestId)}`);
        } catch {
          return c.redirect("/portal/?googlePairing=failed");
        }
      });
    }
    app.post(
      `${base}/request`,
      scope.public(),
      boundedBody,
      validateJson(googlePairingRequestSchema),
      async (c) => {
        if (limiter.consume(clientIp(c)))
          return c.json({ error: "Too many pairing requests" }, 429);
        c.header("Cache-Control", "no-store");
        return c.json(await operate(({ pairing }) => pairing.start(c.req.valid("json"))));
      },
    );
    app.post(`${base}/challenge`, scope.public(), async (c) => {
      if (limiter.consume(clientIp(c))) return c.json({ error: "Too many pairing requests" }, 429);
      c.header("Cache-Control", "no-store");
      return c.json(await operate(({ pairing }) => pairing.issueChallenge()));
    });
    app.post(`${base}/poll`, scope.public(), boundedBody, validateJson(poll), async (c) => {
      if (pollLimiter.consume(clientIp(c)))
        return c.json({ error: "Too many pairing requests" }, 429);
      const value = c.req.valid("json");
      c.header("Cache-Control", "no-store");
      return c.json(await operate(({ pairing }) => pairing.poll(value.requestId, value.secret)));
    });
  }
  app.get("/admin/cloud-pairing/requests", scope.admin(), (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ items: current().pairing.list() });
  });
  app.post(
    "/admin/cloud-pairing/decision",
    scope.admin(),
    boundedBody,
    validateJson(
      z
        .object({
          requestId: z.string().uuid(),
          approve: z.boolean(),
          trustSignIn: z.boolean().optional(),
        })
        .strict(),
    ),
    async (c) => {
      const value = c.req.valid("json");
      await operate(({ pairing }) =>
        pairing.decide(value.requestId, value.approve, {
          ...(value.trustSignIn === undefined ? {} : { trustSignIn: value.trustSignIn }),
        }),
      );
      return c.json({ ok: true });
    },
  );
}
