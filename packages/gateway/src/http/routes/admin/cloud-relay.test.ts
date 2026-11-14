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
// Which sockets the relay tunnel dialled is the tunnel client's own record; it is tested there.
const tunnelSockets = vi.hoisted(() => new Set<string>());
vi.mock("@omnesis/cloud-relay", async (original) => ({
  ...(await original<typeof import("@omnesis/cloud-relay")>()),
  isRelayTunnelPeer: (peer: { remoteAddress?: string; remotePort?: number }) =>
    tunnelSockets.has(`${peer.remoteAddress}|${peer.remotePort}`),
}));
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
let devices:
  | { revokeJoinedWith: ReturnType<typeof vi.fn<(signInId: string) => Promise<string[]>>> }
  | undefined;
beforeEach(() => {
  devices = { revokeJoinedWith: vi.fn(async (_signInId: string): Promise<string[]> => []) };
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
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
  mountCloudRelayManagementRoutes(router, configured ? service : undefined, devices);
  return router;
}
const post = (body: unknown = {}, headers = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
test("management is absent with cloud relay disabled or without a service, and always requires admin", async () => {
  expect((await app(null).request("/admin/cloud-relay")).status).toBe(401);
  expect(
    (await app({ ...bearer, scopes: [SCOPE_READ] }).request("/admin/cloud-relay")).status,
  ).toBe(403);
  expect((await app(bearer, false).request("/admin/cloud-relay")).status).toBe(404);
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "0");
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
    redirectUrl: "https://gateway.example.test/portal/settings/account",
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
    "https://gateway.example.test/portal/settings/account",
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

test("account management requires admin authority, validates bodies and confines browser state to secure cookies", async () => {
  service.accountLink = vi.fn().mockResolvedValue({
    authorizeUrl: "https://relay.example.test/_relay/v3/account-browser/begin?opaque",
    cookie: "__Host-omnesis-gateway-account=opaque; Secure; HttpOnly; Path=/",
  });
  service.accountCallback = vi.fn().mockResolvedValue({
    redirectUrl: "https://gateway.example.test/portal/settings/account",
    cookie: "__Host-omnesis-gateway-account=; Secure; HttpOnly; Path=/; Max-Age=0",
  });
  service.accountUnlink = vi.fn().mockResolvedValue(status);
  expect((await app(null).request("/admin/cloud-relay/account/link", post())).status).toBe(401);
  expect(
    (
      await app({ ...bearer, scopes: [SCOPE_READ] }).request(
        "/admin/cloud-relay/account/unlink",
        post(),
      )
    ).status,
  ).toBe(403);
  expect(
    (await app().request("/admin/cloud-relay/account/link", post({ accountId: "untrusted" })))
      .status,
  ).toBe(400);
  const linked = await app().request(
    "https://gateway.example.test/admin/cloud-relay/account/link",
    post(),
  );
  expect(linked.status).toBe(200);
  expect(linked.headers.get("set-cookie")).toContain("__Host-omnesis-gateway-account=");
  expect(await linked.json()).not.toHaveProperty("cookie");
  expect(service.accountLink).toHaveBeenCalledExactlyOnceWith({
    requestOrigin: "https://gateway.example.test",
  });
  expect((await app().request("/admin/cloud-relay/account/unlink", post())).status).toBe(200);
  const callbackUrl =
    "https://gateway.example.test/admin/cloud-relay/account/callback?state=opaque";
  const callback = await app().request(callbackUrl, {
    headers: { cookie: "__Host-omnesis-gateway-account=opaque" },
  });
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(
    "https://gateway.example.test/portal/settings/account",
  );
  expect(service.accountCallback).toHaveBeenCalledExactlyOnceWith({
    url: callbackUrl,
    cookie: "__Host-omnesis-gateway-account=opaque",
  });
  service.accountCallback = vi
    .fn()
    .mockRejectedValue(new CloudRelayManagementFailure(400, "account-link-failed"));
  expect((await app().request(callbackUrl)).status).toBe(400);
  delete service.accountLink;
  delete service.accountUnlink;
  delete service.accountCallback;
  for (const action of ["link", "unlink"])
    expect((await app().request(`/admin/cloud-relay/account/${action}`, post())).status).toBe(503);
  expect((await app().request(callbackUrl)).status).toBe(503);
});

test("connecting by sign-in, its cancellation, the enrollment policy and trusted sign-ins reach the service with validated inputs", async () => {
  service.connect = vi.fn().mockResolvedValue(status);
  service.cancelConnect = vi.fn().mockResolvedValue(status);
  service.setEnrollmentPolicy = vi.fn().mockResolvedValue(status);
  service.removeTrustedSignIn = vi.fn().mockResolvedValue(status);
  const router = app();
  const put = (body: unknown) => ({ ...post(body), method: "PUT" });
  for (const body of [
    {},
    { termsAccepted: false },
    { termsAccepted: true, relayUrl: "x" },
    { termsAccepted: true, intent: "anything" },
    { termsAccepted: true, intent: null },
    { termsAccepted: false, intent: "create" },
    { intent: "create" },
  ])
    expect((await router.request("/admin/cloud-relay/connect", post(body))).status).toBe(400);
  expect(service.connect).not.toHaveBeenCalled();
  expect(
    (await router.request("/admin/cloud-relay/connect", post({ termsAccepted: true }))).status,
  ).toBe(200);
  expect(service.connect).toHaveBeenCalledExactlyOnceWith({ termsAccepted: true });
  // The portal says whether the person chose to create an account or to sign in to one.
  for (const intent of ["create", "existing"]) {
    expect(
      (await router.request("/admin/cloud-relay/connect", post({ termsAccepted: true, intent })))
        .status,
    ).toBe(200);
    expect(service.connect).toHaveBeenLastCalledWith({ termsAccepted: true, intent });
  }
  expect((await router.request("/admin/cloud-relay/connect/cancel", post({ x: 1 }))).status).toBe(
    400,
  );
  expect((await router.request("/admin/cloud-relay/connect/cancel", post())).status).toBe(200);
  expect(service.cancelConnect).toHaveBeenCalledOnce();
  for (const body of [{}, { policy: "open" }, { policy: "ask", extra: true }])
    expect((await router.request("/admin/cloud-relay/enrollment", put(body))).status).toBe(400);
  expect(service.setEnrollmentPolicy).not.toHaveBeenCalled();
  for (const policy of ["automatic", "ask"] as const) {
    expect((await router.request("/admin/cloud-relay/enrollment", put({ policy }))).status).toBe(
      200,
    );
    expect(service.setEnrollmentPolicy).toHaveBeenLastCalledWith(policy);
  }
  const removed = await router.request("/admin/cloud-relay/trusted-sign-ins/fictional-pin", {
    method: "DELETE",
  });
  expect(removed.status).toBe(200);
  expect(service.removeTrustedSignIn).toHaveBeenCalledExactlyOnceWith("fictional-pin");
  // Devices that joined with it stay unless the owner asks.
  expect(await removed.json()).not.toHaveProperty("revokedDevices");
  expect(
    (
      await router.request(
        "/admin/cloud-relay/trusted-sign-ins/fictional-pin?revokeDevices=false",
        {
          method: "DELETE",
        },
      )
    ).status,
  ).toBe(200);
  expect(devices!.revokeJoinedWith).not.toHaveBeenCalled();
  vi.mocked(service.connect!).mockRejectedValueOnce(
    new CloudRelayManagementFailure(409, "operation-in-progress"),
  );
  const busy = await router.request("/admin/cloud-relay/connect", post({ termsAccepted: true }));
  expect(busy.status).toBe(409);
  expect(await busy.json()).toEqual({
    error: "Relay operation was refused.",
    code: "operation-in-progress",
  });
  expect(
    (
      await app({ ...bearer, scopes: [SCOPE_READ] }).request(
        "/admin/cloud-relay/enrollment",
        put({ policy: "automatic" }),
      )
    ).status,
  ).toBe(403);
});

test("removing a sign-in can also revoke the devices that joined with it, only after the sign-in is gone", async () => {
  const order: string[] = [];
  service.removeTrustedSignIn = vi.fn(async (id: string) => {
    order.push(`remove ${id}`);
    return status;
  });
  devices!.revokeJoinedWith.mockImplementation(async (id: string) => {
    order.push(`revoke ${id}`);
    return ["device-one", "device-two"];
  });
  const router = app();
  const removed = await router.request(
    "/admin/cloud-relay/trusted-sign-ins/fictional-pin?revokeDevices=true",
    { method: "DELETE" },
  );
  expect(removed.status).toBe(200);
  expect(await removed.json()).toMatchObject({
    revision: 1,
    revokedDevices: ["device-one", "device-two"],
  });
  expect(order).toEqual(["remove fictional-pin", "revoke fictional-pin"]);

  // A refused removal revokes nothing, and the query is validated.
  vi.mocked(service.removeTrustedSignIn!).mockRejectedValueOnce(
    new CloudRelayManagementFailure(409, "configuration-invalid"),
  );
  expect(
    (
      await router.request("/admin/cloud-relay/trusted-sign-ins/other?revokeDevices=true", {
        method: "DELETE",
      })
    ).status,
  ).toBe(409);
  for (const query of ["revokeDevices=yes", "other=true"])
    expect(
      (
        await router.request(`/admin/cloud-relay/trusted-sign-ins/other?${query}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(400);
  expect(devices!.revokeJoinedWith).toHaveBeenCalledTimes(1);

  // Without device access the removal is not offered at all.
  devices = undefined;
  expect(
    (await app().request("/admin/cloud-relay/trusted-sign-ins/other", { method: "DELETE" })).status,
  ).toBe(503);
});

test("sign-in connection controls are explicitly unavailable when the service has no account support", async () => {
  const router = app();
  for (const [path, init] of [
    ["/admin/cloud-relay/connect", post({ termsAccepted: true })],
    ["/admin/cloud-relay/connect/cancel", post()],
    ["/admin/cloud-relay/enrollment", { ...post({ policy: "ask" }), method: "PUT" }],
    ["/admin/cloud-relay/trusted-sign-ins/fictional-pin", { method: "DELETE" }],
    ["/admin/cloud-relay/passkeys/confirm/options", post()],
    ["/admin/cloud-relay/passkeys/confirm", post({ proof: gatewayProof })],
    ["/admin/cloud-relay/trusted-sign-ins", { method: "GET" }],
  ] as const) {
    const response = await router.request(path, init);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Relay operation was refused.",
      code: "account-unavailable",
    });
  }
});
test("reading the status lets the service ask its relay about signup first, and no operation does", async () => {
  const order: string[] = [];
  const signup = {
    inviteOnly: true as const,
    requestAccessUrl: "https://groups.example.com/g/fictional-testers",
  };
  service.refreshSignupAccess = vi.fn(async () => {
    order.push("refresh");
  });
  service.status = vi.fn(async () => {
    order.push("status");
    return { ...status, signup };
  });
  const router = app();
  expect(await (await router.request("/admin/cloud-relay")).json()).toMatchObject({ signup });
  expect(order).toEqual(["refresh", "status"]);
  await router.request("/admin/cloud-relay/disable", post());
  expect(service.refreshSignupAccess).toHaveBeenCalledTimes(1);
  // A service without it (an older implementation) still answers.
  delete service.refreshSignupAccess;
  expect((await app().request("/admin/cloud-relay")).status).toBe(200);
  // Without the flag nothing is read.
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "0");
  service.refreshSignupAccess = vi.fn(async () => {});
  expect((await app().request("/admin/cloud-relay")).status).toBe(404);
  expect(service.refreshSignupAccess).not.toHaveBeenCalled();
});

test("a certificate incident is acknowledged only by an admin request that didn't come through the relay", async () => {
  const held = {
    ...status,
    incidentHold: { since: "2028-01-02T00:00:00.000Z", certificates: ["e".repeat(64)] },
  };
  const acknowledgeIncidentHold = vi.fn().mockResolvedValue(status);
  service = { ...service, acknowledgeIncidentHold, status: vi.fn().mockResolvedValue(held) };
  const router = app();
  const socket = (remotePort: number) => ({
    incoming: { socket: { remoteAddress: "127.0.0.1", remotePort } },
  });
  tunnelSockets.add("127.0.0.1|40300");
  try {
    // Through the tunnel, with or without the relay's own marker, an admin token is not enough.
    for (const [headers, env] of [
      [{}, socket(40300)],
      [{ "x-omnesis-cloud-relay": "1" }, socket(40301)],
    ] as const) {
      const refused = await router.request(
        "/admin/cloud-relay/incidents/ack",
        post({}, headers),
        env,
      );
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "local-request-required" });
    }
    expect(acknowledgeIncidentHold).not.toHaveBeenCalled();
    expect(await (await router.request("/admin/cloud-relay")).json()).toMatchObject({
      incidentHold: held.incidentHold,
    });
    // The CLI on the gateway host.
    const local = await router.request("/admin/cloud-relay/incidents/ack", post(), socket(40302));
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual(status);
    expect(acknowledgeIncidentHold).toHaveBeenCalledOnce();
  } finally {
    tunnelSockets.clear();
  }
  // Admin only, a body of nothing, and unavailable without account support.
  expect(
    (
      await app({ ...bearer, scopes: [SCOPE_READ] }).request(
        "/admin/cloud-relay/incidents/ack",
        post(),
      )
    ).status,
  ).toBe(403);
  expect(
    (await router.request("/admin/cloud-relay/incidents/ack", post({ force: true }))).status,
  ).toBe(400);
  delete service.acknowledgeIncidentHold;
  const unavailable = await app().request("/admin/cloud-relay/incidents/ack", post());
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({ code: "account-unavailable" });
  // Without the opt-in the route doesn't exist.
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "0");
  expect((await app().request("/admin/cloud-relay/incidents/ack", post())).status).toBe(404);
});

const gatewayProof = {
  type: "gateway-passkey",
  challenge: "Y2hhbGxlbmdlY2hhbGxlbmdlY2hhbGxlbmdlY2hhbGw",
  credential: {
    id: "Y3JlZGVudGlhbA",
    rawId: "Y3JlZGVudGlhbA",
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: "e30",
      authenticatorData: "YXV0aA",
      signature: "c2ln",
      userHandle: "dXNlcg",
    },
  },
};

test("confirming a passkey on the gateway's page and listing sign-ins are admin-only and validated", async () => {
  const ceremony = {
    purpose: "pin-passkey" as const,
    rpId: "relay.example.test",
    origin: "https://g-abcdefgh.relay.example.test",
    challenge: gatewayProof.challenge,
    binding: "binding",
    webauthnChallenge: "webauthn-challenge",
    expiresAt: 1,
  };
  service.passkeyConfirmation = vi.fn().mockResolvedValue(ceremony);
  service.confirmPasskey = vi.fn().mockResolvedValue(status);
  const router = app();
  expect(
    (await router.request("/admin/cloud-relay/passkeys/confirm/options", post({ x: 1 }))).status,
  ).toBe(400);
  const options = await router.request("/admin/cloud-relay/passkeys/confirm/options", post());
  expect(options.status).toBe(200);
  expect(options.headers.get("cache-control")).toBe("no-store");
  expect(await options.json()).toEqual(ceremony);
  // Only a gateway-passkey assertion is accepted: no relay-page proof, nothing extra.
  for (const body of [
    {},
    { proof: { ...gatewayProof, type: "passkey" } },
    { proof: { ...gatewayProof, issuedAt: "1794240000" } },
    { proof: gatewayProof, extra: true },
  ])
    expect((await router.request("/admin/cloud-relay/passkeys/confirm", post(body))).status).toBe(
      400,
    );
  expect(service.confirmPasskey).not.toHaveBeenCalled();
  expect(
    (await router.request("/admin/cloud-relay/passkeys/confirm", post({ proof: gatewayProof })))
      .status,
  ).toBe(200);
  expect(service.confirmPasskey).toHaveBeenCalledExactlyOnceWith(gatewayProof);
  vi.mocked(service.confirmPasskey!).mockRejectedValueOnce(
    new CloudRelayManagementFailure(403, "passkey-not-confirmed"),
  );
  const refused = await router.request(
    "/admin/cloud-relay/passkeys/confirm",
    post({ proof: gatewayProof }),
  );
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "passkey-not-confirmed" });
  for (const [path, init] of [
    ["/admin/cloud-relay/passkeys/confirm/options", post()],
    ["/admin/cloud-relay/passkeys/confirm", post({ proof: gatewayProof })],
    ["/admin/cloud-relay/trusted-sign-ins", { method: "GET" }],
  ] as const)
    expect((await app({ ...bearer, scopes: [SCOPE_READ] }).request(path, init)).status).toBe(403);

  // The list names each pin's source and whether it was confirmed here, and adds confirmations
  // of sign-ins that are not pinned.
  vi.mocked(service.status).mockResolvedValue({
    ...status,
    deviceEnrollment: {
      policy: "automatic",
      confirmationNeeded: false,
      trustedSignIns: [
        { type: "passkey", id: "p1", addedAt: 1, source: "link-page", confirmed: true },
        { type: "google", id: "g1", addedAt: 2, source: "countersigned", confirmed: false },
      ],
      confirmedSignIns: [
        { type: "passkey", id: "p1", at: 3, via: "gateway-origin" },
        { type: "passkey", id: "p2", at: 4, via: "android-app" },
      ],
      confirmOrigin: ceremony.origin,
    },
  });
  const listed = await router.request("/admin/cloud-relay/trusted-sign-ins");
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({
    items: [
      {
        type: "passkey",
        id: "p1",
        addedAt: 1,
        source: "link-page",
        confirmed: true,
        via: "gateway-origin",
      },
      { type: "google", id: "g1", addedAt: 2, source: "countersigned", confirmed: false },
      { type: "passkey", id: "p2", addedAt: 4, confirmed: true, via: "android-app" },
    ],
    confirmOrigin: ceremony.origin,
  });
  vi.mocked(service.status).mockResolvedValue({
    ...status,
    deviceEnrollment: {
      policy: "ask",
      confirmationNeeded: true,
      trustedSignIns: [],
      confirmedSignIns: [],
    },
  });
  expect(await (await router.request("/admin/cloud-relay/trusted-sign-ins")).json()).toEqual({
    items: [],
  });
});
