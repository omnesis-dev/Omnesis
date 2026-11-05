// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { CloudRelayManagementFailure } from "@omnesis/cloud-relay";
import { strictRoute } from "../../scope.js";
import { HttpError, errorResponse } from "../../errors.js";
import { mountCloudRelayManagementRoutes } from "./cloud-relay.js";
import type { AppEnv, AuthContext } from "../types.js";
import type { CloudRelayManagement, CloudRelayManagementStatus } from "@omnesis/cloud-relay";
const status: CloudRelayManagementStatus = {
  revision: 1,
  enabled: false,
  configured: false,
  config: { termsAccepted: false, invitationRequired: true },
  enrollment: { state: "unconfigured" },
  tunnel: { state: "disabled" },
  certificate: { state: "unconfigured" },
  publicMcp: { ready: false },
  google: { configured: false },
  can: { configure: true, enable: false, disable: false, reconnect: false, renew: false },
};
const bearer: AuthContext = {
  authMethod: "bearer",
  deviceId: null,
  tokenId: null,
  scopes: [SCOPE_ADMIN],
};
let service: CloudRelayManagement;
beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  service = {
    status: vi.fn().mockResolvedValue(status),
    configure: vi.fn().mockResolvedValue(status),
    enable: vi.fn().mockResolvedValue(status),
    disable: vi.fn().mockResolvedValue(status),
    reconnect: vi.fn().mockResolvedValue(status),
    renew: vi.fn().mockResolvedValue(status),
  };
});
afterEach(() => vi.unstubAllEnvs());
function app(auth: AuthContext | null = bearer, configured = true) {
  const router = strictRoute(new Hono<AppEnv>());
  router.onError((e, c) => {
    if (e instanceof HttpError) return errorResponse(c, e);
    if (e instanceof HTTPException) return e.getResponse();
    throw e;
  });
  router.use("*", async (c, next) => {
    if (auth) c.set("auth", auth);
    await next();
  });
  mountCloudRelayManagementRoutes(router, configured ? service : undefined);
  return router;
}
const post = (body: unknown = {}, headers = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
test("management is absent off experimental or without a service, and always requires admin", async () => {
  expect((await app(null).request("/admin/cloud-relay")).status).toBe(401);
  expect(
    (await app({ ...bearer, scopes: [SCOPE_READ] }).request("/admin/cloud-relay")).status,
  ).toBe(403);
  expect((await app(bearer, false).request("/admin/cloud-relay")).status).toBe(404);
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  expect((await app().request("/admin/cloud-relay")).status).toBe(404);
  expect(service.status).not.toHaveBeenCalled();
});
test("reads and operates the lifecycle service with exact validated inputs and no caching", async () => {
  const router = app();
  const response = await router.request("/admin/cloud-relay");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(status);
  const config = {
    relayUrl: "https://relay.example.test",
    publicOrigin: "https://gateway.example.test",
    acmeDirectoryUrl: "https://ca.example.test/directory",
    termsAccepted: true,
  };
  expect((await router.request("/admin/cloud-relay/configure", post(config))).status).toBe(200);
  expect(service.configure).toHaveBeenCalledExactlyOnceWith(config);
  expect(
    (
      await router.request(
        "/admin/cloud-relay/enable",
        post({ invitation: "fictional-invitation" }),
      )
    ).status,
  ).toBe(200);
  expect(service.enable).toHaveBeenCalledExactlyOnceWith({ invitation: "fictional-invitation" });
  for (const operation of ["disable", "reconnect", "renew"] as const) {
    expect((await router.request(`/admin/cloud-relay/${operation}`, post())).status).toBe(200);
    expect(service[operation]).toHaveBeenCalledOnce();
  }
});
test("cookie-based mutations require the portal CSRF token while bearer admin clients work", async () => {
  const csrf = "a".repeat(64);
  const router = app({
    authMethod: "portal-session",
    deviceId: null,
    tokenId: null,
    credentialDeviceId: null,
    scopes: [SCOPE_ADMIN],
    csrfToken: csrf,
  });
  expect((await router.request("/admin/cloud-relay")).status).toBe(200);
  expect((await router.request("/admin/cloud-relay/disable", post())).status).toBe(403);
  expect(
    (
      await router.request(
        "/admin/cloud-relay/disable",
        post({}, { "X-Omnesis-CSRF": "b".repeat(64) }),
      )
    ).status,
  ).toBe(403);
  expect(
    (await router.request("/admin/cloud-relay/disable", post({}, { "X-Omnesis-CSRF": csrf })))
      .status,
  ).toBe(200);
  expect(service.disable).toHaveBeenCalledOnce();
});
test("rejects malformed, unknown and oversized inputs before invoking service operations", async () => {
  const router = app();
  for (const value of [
    null,
    [],
    { relayUrl: "invalid" },
    { relayUrl: "https://relay.example.test", privateKey: "forbidden" },
    { relayUrl: "https://relay.example.test", termsAccepted: "true" },
  ])
    expect((await router.request("/admin/cloud-relay/configure", post(value))).status).toBe(400);
  expect(
    (await router.request("/admin/cloud-relay/enable", post({ invitation: "x".repeat(8193) })))
      .status,
  ).toBe(400);
  expect(
    (await router.request("/admin/cloud-relay/enable", post({ invitation: "x".repeat(17000) })))
      .status,
  ).toBe(413);
  expect((await router.request("/admin/cloud-relay/renew", post({ force: true }))).status).toBe(
    400,
  );
  expect(service.configure).not.toHaveBeenCalled();
  expect(service.enable).not.toHaveBeenCalled();
  expect(service.renew).not.toHaveBeenCalled();
});
test("unexpected errors are sanitized and never include credentials or filesystem details", async () => {
  vi.mocked(service.status).mockRejectedValue(new Error("/private/key.pem token=secret"));
  const response = await app().request("/admin/cloud-relay");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "Relay management is unavailable. Try again.",
    code: "relay-management-unavailable",
  });
});

test("typed operation refusals preserve only the public error code and status", async () => {
  for (const [statusCode, code] of [
    [400, "ca-terms-required"],
    [409, "operation-in-progress"],
    [503, "relay-unreachable"],
  ] as const) {
    vi.mocked(service.enable).mockRejectedValueOnce(
      new CloudRelayManagementFailure(statusCode, code),
    );
    const response = await app().request("/admin/cloud-relay/enable", post());
    expect(response.status).toBe(statusCode);
    expect(await response.json()).toEqual({ error: "Relay operation was refused.", code });
  }
});

test("Google linking starts only as an authenticated admin and keeps its browser state in an HttpOnly cookie", async () => {
  service.googleLink = vi.fn().mockResolvedValue({
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fictional",
    cookie:
      "omnesis-relay-google=fictional-browser-state; HttpOnly; Secure; SameSite=Lax; Path=/admin/cloud-relay/google/callback",
  });
  const response = await app().request(
    "https://gateway.example.test/admin/cloud-relay/google/link",
    post(),
  );
  expect(response.status).toBe(200);
  expect(service.googleLink).toHaveBeenCalledExactlyOnceWith({
    requestOrigin: "https://gateway.example.test",
  });
  expect(response.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
  expect(await response.json()).toEqual({
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fictional",
  });
  expect((await app(null).request("/admin/cloud-relay/google/link", post())).status).toBe(401);
  service.googleUnlink = vi.fn().mockResolvedValue(status);
  expect((await app().request("/admin/cloud-relay/google/unlink", post())).status).toBe(200);
  expect(service.googleUnlink).toHaveBeenCalledOnce();
});
test("Google actions are explicitly unavailable when gateway-specific linking is not configured", async () => {
  for (const operation of ["link", "unlink"]) {
    const response = await app().request(`/admin/cloud-relay/google/${operation}`, post());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Relay operation was refused.",
      code: "google-unavailable",
    });
  }
});

test("Google callback rechecks admin and sends browser state only to its backend before a fixed return", async () => {
  service.googleCallback = vi.fn().mockResolvedValue({
    redirectUrl: "https://gateway.example.test/portal/settings/relay",
    cookie: "private-browser-state=; Max-Age=0; Secure; HttpOnly",
  });
  const url =
    "https://gateway.example.test/admin/cloud-relay/google/callback?code=fictional&state=fictional";
  expect((await app(null).request(url)).status).toBe(401);
  expect(service.googleCallback).not.toHaveBeenCalled();
  const response = await app().request(url, {
    headers: { cookie: "private-browser-state=fictional" },
  });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(
    "https://gateway.example.test/portal/settings/relay",
  );
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(service.googleCallback).toHaveBeenCalledWith({
    url,
    cookie: "private-browser-state=fictional",
  });
  service.googleCallback = undefined;
  expect((await app().request(url)).status).toBe(503);
});

test("configuration accepts no request-selected service and preserves typed installation refusals", async () => {
  const router = app();
  expect(
    (await router.request("/admin/cloud-relay/configure", post({ termsAccepted: true }))).status,
  ).toBe(200);
  expect(service.configure).toHaveBeenCalledWith({ termsAccepted: true });
  for (const [code, statusCode] of [
    ["relay-service-mismatch", 400],
    ["relay-service-unavailable", 503],
  ] as const) {
    vi.mocked(service.configure).mockRejectedValueOnce(
      new CloudRelayManagementFailure(statusCode, code),
    );
    const response = await router.request("/admin/cloud-relay/configure", post({}));
    expect(response.status).toBe(statusCode);
    expect(await response.json()).toMatchObject({ code });
  }
});
