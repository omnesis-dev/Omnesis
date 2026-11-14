// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SCOPE_ADMIN } from "@omnesis/types";
import { gatewayPasskeyStepUpBinding, type GatewayEnrollment } from "@omnesis/cloud-relay";
import { scope, strictRoute } from "./scope.js";
import { HttpError, errorResponse } from "./errors.js";
import {
  STEP_UP_TTL_MS,
  StepUps,
  asksFirst,
  declines,
  mountStepUp,
  requireStepUp,
} from "./step-up.js";
import type { AppEnv, AuthContext } from "./routes/types.js";
import type { DeviceId, TokenId } from "@omnesis/types";

const opaque = () => randomBytes(32).toString("base64url");
const DEVICE = "dev_fictional_phone" as DeviceId;
const bearer: AuthContext = {
  authMethod: "bearer",
  deviceId: DEVICE,
  tokenId: "tok_fictional" as TokenId,
  scopes: [SCOPE_ADMIN],
};
const RELAYED = { "x-omnesis-cloud-relay": "1" };
const CSRF = { "X-Omnesis-CSRF": "x" };

/** A stand-in for the linked account: one confirmed passkey, and ceremonies it can answer. */
function account() {
  const ceremonies = new Map<string, string>();
  const state = { confirmed: true, origin: true as boolean, accept: true };
  const enrollment = {
    stepUpRequired: () => state.confirmed,
    gatewayPasskey: () =>
      state.origin ? { rpId: "relay.example.test", origin: "https://g-1.example.test" } : undefined,
    stepUpCeremony: vi.fn((binding: string) => {
      if (!state.origin) return undefined;
      const challenge = opaque();
      ceremonies.set(challenge, binding);
      return { purpose: "step-up", challenge, binding, webauthnChallenge: opaque() };
    }),
    verifyStepUp: vi.fn((proof: unknown, binding: string) => {
      const challenge = (proof as { challenge: string }).challenge;
      const issued = ceremonies.get(challenge);
      ceremonies.delete(challenge);
      return Promise.resolve(state.accept && issued === binding);
    }),
  } as unknown as GatewayEnrollment;
  return { enrollment, state };
}

let clock = 1_000_000;
let methods: Record<string, string>;
let linked: ReturnType<typeof account> | undefined;
const handled = vi.fn();

beforeEach(() => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  clock = 1_000_000;
  methods = {};
  linked = account();
  handled.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

function app(auth: AuthContext | null = bearer) {
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
  mountStepUp(router, {
    enrollment: () => linked?.enrollment,
    enrollmentMethod: (deviceId) => methods[deviceId],
    now: () => clock,
  });
  router.post("/admin/devices/pair", scope.admin(), requireStepUp(), async (c) => {
    handled(await c.req.json());
    return c.json({ ok: true });
  });
  router.put(
    "/admin/cloud-relay/enrollment",
    scope.admin(),
    requireStepUp(asksFirst),
    async (c) => {
      handled(await c.req.json());
      return c.json({ ok: true });
    },
  );
  return router;
}

const json = (method: string, body: string, headers: Record<string, string> = {}) => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  body,
});
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const proof = (challenge: string) => ({
  type: "gateway-passkey",
  challenge,
  credential: {
    id: "Y3JlZA",
    rawId: "Y3JlZA",
    type: "public-key",
    clientExtensionResults: {},
    response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA", userHandle: "dQ" },
  },
});

/** The owner's step-up for one request, as the portal runs it: options, passkey, id. */
async function stepUp(
  router: ReturnType<typeof app>,
  request: { method: string; path: string; body: string },
  headers: Record<string, string> = RELAYED,
) {
  const target = { method: request.method, path: request.path, bodySha256: sha256(request.body) };
  const options = await router.request(
    "/admin/step-up/options",
    json("POST", JSON.stringify(target), headers),
  );
  expect(options.status).toBe(200);
  const ceremony = (await options.json()) as { challenge: string };
  const response = await router.request(
    "/admin/step-up",
    json("POST", JSON.stringify({ ...target, proof: proof(ceremony.challenge) }), headers),
  );
  return response;
}

const PAIR = { method: "POST", path: "/admin/devices/pair", body: '{"kind":"cli"}' };

test("F21: a relayed admin request needs a step-up to mint a pairing code, and says how to get one", async () => {
  const router = app();
  const refused = await router.request(PAIR.path, json("POST", PAIR.body, RELAYED));
  expect(refused.status).toBe(428);
  expect(await refused.json()).toEqual({
    error: expect.any(String),
    code: "STEP_UP_REQUIRED",
    detail: {
      method: "POST",
      path: "/admin/devices/pair",
      bodySha256: sha256(PAIR.body),
      options: "/admin/step-up/options",
      header: "X-Omnesis-Step-Up",
    },
  });
  expect(handled).not.toHaveBeenCalled();
});

test("the owner steps up once with a passkey confirmed here, and that id carries exactly one request", async () => {
  const router = app();
  const issued = await stepUp(router, PAIR);
  expect(issued.status).toBe(200);
  expect(issued.headers.get("cache-control")).toBe("no-store");
  const { stepUpId, expiresAt } = (await issued.json()) as { stepUpId: string; expiresAt: number };
  expect(expiresAt).toBe(clock + STEP_UP_TTL_MS);
  // The binding names the method, the path, the body's hash and the requesting device.
  expect(linked!.enrollment.stepUpCeremony).toHaveBeenCalledWith(
    gatewayPasskeyStepUpBinding({
      method: "POST",
      path: "/admin/devices/pair",
      bodySha256: sha256(PAIR.body),
      deviceId: DEVICE,
    }),
  );
  const ok = await router.request(
    PAIR.path,
    json("POST", PAIR.body, { ...RELAYED, "X-Omnesis-Step-Up": stepUpId }),
  );
  expect(ok.status).toBe(200);
  expect(handled).toHaveBeenCalledWith({ kind: "cli" });
  // Used twice: refused.
  const again = await router.request(
    PAIR.path,
    json("POST", PAIR.body, { ...RELAYED, "X-Omnesis-Step-Up": stepUpId }),
  );
  expect(again.status).toBe(428);
  expect(handled).toHaveBeenCalledTimes(1);
});

test("a step-up for one action can't be used for another: another body, path, method or query", async () => {
  const router = app();
  for (const use of [
    { ...PAIR, body: '{"kind":"ios"}' },
    { method: "PUT", path: "/admin/cloud-relay/enrollment", body: '{"policy":"automatic"}' },
    { ...PAIR, path: "/admin/devices/pair?kind=ios" },
  ]) {
    const { stepUpId } = (await (await stepUp(router, PAIR)).json()) as { stepUpId: string };
    const response = await router.request(
      use.path,
      json(use.method, use.body, { ...RELAYED, "X-Omnesis-Step-Up": stepUpId }),
    );
    expect(response.status, JSON.stringify(use)).toBe(428);
    // Spent by that attempt: not even its own request can use it now.
    const own = await router.request(
      PAIR.path,
      json("POST", PAIR.body, { ...RELAYED, "X-Omnesis-Step-Up": stepUpId }),
    );
    expect(own.status).toBe(428);
  }
  expect(handled).not.toHaveBeenCalled();
});

test("a step-up for another device on the same gateway is refused", async () => {
  const router = strictRoute(new Hono<AppEnv>());
  let who: AuthContext = bearer;
  router.onError((e, c) => (e instanceof HttpError ? errorResponse(c, e) : Promise.reject(e)));
  router.use("*", async (c, next) => {
    c.set("auth", who);
    await next();
  });
  mountStepUp(router, {
    enrollment: () => linked!.enrollment,
    enrollmentMethod: () => undefined,
    now: () => clock,
  });
  router.post("/admin/devices/pair", scope.admin(), requireStepUp(), (c) => c.json({ ok: true }));
  const { stepUpId } = (await (await stepUp(router as never, PAIR)).json()) as {
    stepUpId: string;
  };
  who = { ...bearer, deviceId: "dev_fictional_other" as DeviceId };
  const response = await router.request(
    PAIR.path,
    json("POST", PAIR.body, { ...RELAYED, "X-Omnesis-Step-Up": stepUpId }),
  );
  expect(response.status).toBe(428);
});

test("an expired step-up id is refused, and so is one never issued", async () => {
  const router = app();
  const { stepUpId } = (await (await stepUp(router, PAIR)).json()) as { stepUpId: string };
  clock += STEP_UP_TTL_MS;
  const late = await router.request(
    PAIR.path,
    json("POST", PAIR.body, { ...RELAYED, "X-Omnesis-Step-Up": stepUpId }),
  );
  expect(late.status).toBe(428);
  const madeUp = await router.request(
    PAIR.path,
    json("POST", PAIR.body, { ...RELAYED, "X-Omnesis-Step-Up": opaque() }),
  );
  expect(madeUp.status).toBe(428);
  expect(handled).not.toHaveBeenCalled();
});

test("only a passkey the owner confirmed here steps up", async () => {
  const router = app();
  linked!.state.accept = false;
  const refused = await stepUp(router, PAIR);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "STEP_UP_REFUSED" });
  // A ceremony the gateway never issued.
  const target = { method: "POST", path: PAIR.path, bodySha256: sha256(PAIR.body) };
  linked!.state.accept = true;
  const invented = await router.request(
    "/admin/step-up",
    json("POST", JSON.stringify({ ...target, proof: proof(opaque()) }), RELAYED),
  );
  expect(invented.status).toBe(403);
  // A body that is not exactly a request and an assertion.
  const extra = await router.request(
    "/admin/step-up",
    json("POST", JSON.stringify({ ...target, proof: proof(opaque()), more: 1 }), RELAYED),
  );
  expect(extra.status).toBe(400);
});

test("during a certificate incident (no origin of its own) no step-up starts and guarded actions are refused", async () => {
  const router = app();
  const { stepUpId } = (await (await stepUp(router, PAIR)).json()) as { stepUpId: string };
  linked!.state.origin = false;
  const options = await router.request(
    "/admin/step-up/options",
    json(
      "POST",
      JSON.stringify({ method: "POST", path: PAIR.path, bodySha256: sha256(PAIR.body) }),
      RELAYED,
    ),
  );
  expect(options.status).toBe(403);
  expect(await options.json()).toMatchObject({ code: "STEP_UP_UNAVAILABLE" });
  // Even an id earned before the hold.
  const held = await router.request(
    PAIR.path,
    json("POST", PAIR.body, { ...RELAYED, "X-Omnesis-Step-Up": stepUpId }),
  );
  expect(held.status).toBe(403);
  expect(await held.json()).toMatchObject({ code: "STEP_UP_UNAVAILABLE" });
  // A stricter action still goes through.
  const ask = await router.request(
    "/admin/cloud-relay/enrollment",
    json("PUT", '{"policy":"ask"}', RELAYED),
  );
  expect(ask.status).toBe(200);
  // Without any account at all, no step-up starts either.
  linked = undefined;
  expect(
    (
      await router.request(
        "/admin/step-up/options",
        json(
          "POST",
          JSON.stringify({ method: "POST", path: PAIR.path, bodySha256: sha256(PAIR.body) }),
        ),
      )
    ).status,
  ).toBe(403);
});

test("stricter actions never need a step-up; anything the exemption does not recognise does", async () => {
  const router = app();
  expect(
    (
      await router.request(
        "/admin/cloud-relay/enrollment",
        json("PUT", '{"policy":"ask"}', RELAYED),
      )
    ).status,
  ).toBe(200);
  for (const body of ['{"policy":"automatic"}', '{"policy":"Ask"}', "not json", "{}"])
    expect(
      (await router.request("/admin/cloud-relay/enrollment", json("PUT", body, RELAYED))).status,
      body,
    ).toBe(428);
  // The exemption reads only a JSON body, as the route's validator does.
  const plain = await router.request("/admin/cloud-relay/enrollment", {
    method: "PUT",
    headers: { "content-type": "text/plain", ...RELAYED },
    body: '{"policy":"ask"}',
  });
  expect(plain.status).toBe(428);
});

test("who must step up: relayed requests and devices that joined on their own; the gateway's host, code-paired devices and approved ones don't", async () => {
  // A loopback or home-network request from a device paired by code or QR.
  expect((await app().request(PAIR.path, json("POST", PAIR.body))).status).toBe(200);
  methods[DEVICE] = "approved";
  expect((await app().request(PAIR.path, json("POST", PAIR.body))).status).toBe(200);
  // A device that joined automatically, even on the home network.
  methods[DEVICE] = "automatic";
  expect((await app().request(PAIR.path, json("POST", PAIR.body))).status).toBe(428);
  // A portal session opened with such a device's credential.
  const portal: AuthContext = {
    authMethod: "portal-session",
    deviceId: null,
    credentialDeviceId: DEVICE,
    tokenId: "tok_fictional" as TokenId,
    scopes: [SCOPE_ADMIN],
    csrfToken: "x",
  };
  expect((await app(portal).request(PAIR.path, json("POST", PAIR.body, CSRF))).status).toBe(428);
  // A session with no device behind it is only judged by how it arrived.
  const deviceless = { ...portal, credentialDeviceId: null };
  expect((await app(deviceless).request(PAIR.path, json("POST", PAIR.body, CSRF))).status).toBe(
    200,
  );
  expect(
    (await app(deviceless).request(PAIR.path, json("POST", PAIR.body, { ...CSRF, ...RELAYED })))
      .status,
  ).toBe(428);
  // Unauthenticated requests reach the route's own refusal.
  expect((await app(null).request(PAIR.path, json("POST", PAIR.body, RELAYED))).status).toBe(401);
});

test("nothing changes before the owner confirms a passkey, without an account, or without the opt-in", async () => {
  linked!.state.confirmed = false;
  expect((await app().request(PAIR.path, json("POST", PAIR.body, RELAYED))).status).toBe(200);
  linked = undefined;
  expect((await app().request(PAIR.path, json("POST", PAIR.body, RELAYED))).status).toBe(200);
  linked = account();
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "0");
  const router = app();
  expect((await router.request(PAIR.path, json("POST", PAIR.body, RELAYED))).status).toBe(200);
  expect(
    (
      await router.request(
        "/admin/step-up/options",
        json(
          "POST",
          JSON.stringify({ method: "POST", path: PAIR.path, bodySha256: sha256(PAIR.body) }),
        ),
      )
    ).status,
  ).toBe(404);
  // A route guarded on an app that never mounted step-up behaves as before.
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  const bare = strictRoute(new Hono<AppEnv>());
  bare.post("/admin/devices/pair", scope.public(), requireStepUp(), (c) => c.json({ ok: true }));
  expect((await bare.request(PAIR.path, json("POST", PAIR.body, RELAYED))).status).toBe(200);
});

test("at most 64 step-ups wait at once; the oldest goes first", async () => {
  const router = app();
  const first = (await (await stepUp(router, PAIR)).json()) as { stepUpId: string };
  for (let index = 0; index < 64; index++) await stepUp(router, PAIR);
  const evicted = await router.request(
    PAIR.path,
    json("POST", PAIR.body, { ...RELAYED, "X-Omnesis-Step-Up": first.stepUpId }),
  );
  expect(evicted.status).toBe(428);
  // Expired ones are swept when the next is issued.
  clock += STEP_UP_TTL_MS;
  const fresh = (await (await stepUp(router, PAIR)).json()) as { stepUpId: string };
  expect(
    (
      await router.request(
        PAIR.path,
        json("POST", PAIR.body, { ...RELAYED, "X-Omnesis-Step-Up": fresh.stepUpId }),
      )
    ).status,
  ).toBe(200);
});

test("only a recognised stricter body is exempt", () => {
  expect(declines({ approve: false })).toBe(true);
  expect(asksFirst({ policy: "ask" })).toBe(true);
  for (const body of [undefined, null, {}, { approve: true }, { approve: "false" }, "false"])
    expect(declines(body), JSON.stringify(body)).toBe(false);
  for (const body of [undefined, null, {}, { policy: "automatic" }, "ask"])
    expect(asksFirst(body), JSON.stringify(body)).toBe(false);
});

test("an exempt-looking body without a JSON content type still needs a step-up", async () => {
  const router = app();
  const response = await router.request("/admin/cloud-relay/enrollment", {
    method: "PUT",
    headers: RELAYED,
    body: new Blob(['{"policy":"ask"}']),
  });
  expect(response.status).toBe(428);
});

test("an id is bound to the credential when the request speaks for no device", async () => {
  const deviceless: AuthContext = {
    authMethod: "portal-session",
    deviceId: null,
    credentialDeviceId: null,
    tokenId: "tok_fictional_session" as TokenId,
    scopes: [SCOPE_ADMIN],
    csrfToken: "x",
  };
  const router = app(deviceless);
  const headers = { ...RELAYED, ...CSRF };
  const target = { method: "POST", path: PAIR.path, bodySha256: sha256(PAIR.body) };
  await router.request("/admin/step-up/options", json("POST", JSON.stringify(target), headers));
  expect(linked!.enrollment.stepUpCeremony).toHaveBeenCalledWith(
    gatewayPasskeyStepUpBinding({ ...target, deviceId: "token:tok_fictional_session" }),
  );
  // A bearer token with no device row behind it.
  await app({ ...bearer, deviceId: null }).request(
    "/admin/step-up/options",
    json("POST", JSON.stringify(target), RELAYED),
  );
  expect(linked!.enrollment.stepUpCeremony).toHaveBeenLastCalledWith(
    gatewayPasskeyStepUpBinding({ ...target, deviceId: "token:tok_fictional" }),
  );
});

test("an account that offers no step-up methods asks for none, and starts none", async () => {
  linked = { enrollment: {} as GatewayEnrollment, state: account().state };
  const router = app();
  expect((await router.request(PAIR.path, json("POST", PAIR.body, RELAYED))).status).toBe(200);
  // One that requires a step-up but can't run one refuses, at every step.
  linked = {
    enrollment: { stepUpRequired: () => true } as unknown as GatewayEnrollment,
    state: account().state,
  };
  expect((await router.request(PAIR.path, json("POST", PAIR.body, RELAYED))).status).toBe(403);
  const target = { method: "POST", path: PAIR.path, bodySha256: sha256(PAIR.body) };
  expect(
    (await router.request("/admin/step-up/options", json("POST", JSON.stringify(target), RELAYED)))
      .status,
  ).toBe(403);
  const assertion = await router.request(
    "/admin/step-up",
    json("POST", JSON.stringify({ ...target, proof: proof(opaque()) }), RELAYED),
  );
  expect(await assertion.json()).toMatchObject({ code: "STEP_UP_REFUSED" });
});

test("ids keep the real clock when no other is given", () => {
  const stepUps = new StepUps({ enrollment: () => undefined, enrollmentMethod: () => undefined });
  const { stepUpId, expiresAt } = stepUps.issue("binding");
  expect(expiresAt).toBeGreaterThan(Date.now());
  expect(stepUps.take(stepUpId, "binding")).toBe(true);
});
