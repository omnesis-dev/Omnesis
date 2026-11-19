// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Step-up: one passkey confirmation on the gateway's own page before an administrative action
 * that loosens the gateway (approving a device, trusting a sign-in, choosing automatic joins,
 * confirming a passkey, minting a pairing code or a token, moving a device to another access
 * level). See docs/device-enrollment.md, "Step-up".
 *
 * Only once the owner confirmed a passkey here, on a linked Omnesis account. Then a
 * request that arrived through the relay, or one from a device that joined by signing in on its
 * own (`enrollment_method = automatic`), must carry `X-Omnesis-Step-Up`: the id that
 * `POST /admin/step-up` returned for this exact request (method, path, body and device) within
 * the last minute, used once. The gateway's own host, home-network devices paired by code or QR
 * and the local CLI never need it. Actions that make the gateway stricter (deny, "ask me
 * first", removing a sign-in, revoking a device) never need it either, nor does a phone minting
 * its own notification credential (`ownPushClaimToken`), which adds no access.
 *
 * A guarded request without a valid step-up is refused with 428 `STEP_UP_REQUIRED`, whose
 * `detail` names what to step up for. While no step-up can start (a certificate incident holds
 * the gateway, or it has no origin of its own), it is refused with 403 `STEP_UP_UNAVAILABLE`,
 * whose `detail.reason` is `security-lock` during an incident.
 *
 * `required(c)` also answers ahead of time whether this session's loosening actions will ask,
 * so a page can say so on the button (`stepUpRequired`). That answer only labels: every guarded
 * request is still checked here, one at a time.
 */

import { createHash, randomBytes } from "node:crypto";
import { SCOPE_PUSH_CLAIM } from "@omnesis/types";
import {
  gatewayPasskeySignInProofSchema,
  gatewayPasskeyStepUpBinding,
  type GatewayEnrollment,
} from "@omnesis/cloud-relay";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { arrivedThroughRelay } from "./client-ip.js";
import { HttpError } from "./errors.js";
import { scope } from "./scope.js";
import { validateJson } from "./validate.js";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, AuthContext, RouteApp } from "./routes/types.js";

/** The header a guarded request carries its step-up id in. */
export const STEP_UP_HEADER = "X-Omnesis-Step-Up";
/** How long a step-up id stays usable. */
export const STEP_UP_TTL_MS = 60_000;
const MAX_OUTSTANDING = 64;
const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(;.*)?$/i;

export interface StepUpSource {
  /** The linked account's enrollment, or undefined when the gateway has none. */
  enrollment(): GatewayEnrollment | undefined;
  /** How a device joined: `automatic`, `approved`, or undefined for every other device. */
  enrollmentMethod(deviceId: string): string | undefined;
  now?(): number;
}

/** The device a request speaks for: its own, or the one a portal session was opened with. */
function requestingDevice(auth: AuthContext): string | null {
  return auth.deviceId ?? (auth.authMethod === "portal-session" ? auth.credentialDeviceId : null);
}

/** What a step-up is bound to on the requester's side: its device, else its credential. */
function requester(auth: AuthContext): string {
  return requestingDevice(auth) ?? `token:${auth.tokenId}`;
}

/** Declining a held request only makes the gateway stricter. */
export const declines = (body: unknown): boolean =>
  (body as { approve?: unknown } | null | undefined)?.approve === false;
/** So does choosing "ask me first". */
export const asksFirst = (body: unknown): boolean =>
  (body as { policy?: unknown } | null | undefined)?.policy === "ask";
/**
 * A phone's own notification credential: a token for the requesting device itself whose scopes
 * are exactly `push:claim`, asked for with a device bearer token that already carries
 * `push:claim`. That token can do nothing its caller can't: `push:claim` only claims and confirms
 * the queued notifications of the device it belongs to (`scope.pushClaim()`), and no other scope
 * is satisfied by it. The iOS and Android apps mint it for their notification handling.
 */
export const ownPushClaimToken = (body: unknown, c: Context<AppEnv>): boolean => {
  const auth = c.get("auth");
  const value = body as { deviceId?: unknown; scopes?: unknown } | null | undefined;
  return (
    auth?.authMethod === "bearer" &&
    typeof auth.deviceId === "string" &&
    auth.scopes.includes(SCOPE_PUSH_CLAIM) &&
    value?.deviceId === auth.deviceId &&
    Array.isArray(value.scopes) &&
    value.scopes.length === 1 &&
    value.scopes[0] === SCOPE_PUSH_CLAIM
  );
};

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Step-up ids this gateway handed out, each for one request, for one minute, used once. */
export class StepUps {
  private readonly issued = new Map<string, { binding: string; expiresAt: number }>();
  private readonly now: () => number;
  constructor(readonly source: StepUpSource) {
    this.now = source.now ?? Date.now;
  }

  /** Whether this request must carry a step-up before it may loosen the gateway. */
  required(c: Context<AppEnv>): boolean {
    if (!this.source.enrollment()?.stepUpRequired?.()) return false;
    if (arrivedThroughRelay((name) => c.req.header(name), c.env)) return true;
    const device = requestingDevice(c.get("auth"));
    return device !== null && this.source.enrollmentMethod(device) === "automatic";
  }

  /** Whether a step-up can start now: the gateway has an origin of its own, and no incident. */
  available(): boolean {
    return this.source.enrollment()?.gatewayPasskey?.() !== undefined;
  }

  issue(binding: string): { stepUpId: string; expiresAt: number } {
    const now = this.now();
    for (const [id, value] of this.issued) if (value.expiresAt <= now) this.issued.delete(id);
    while (this.issued.size >= MAX_OUTSTANDING)
      this.issued.delete(this.issued.keys().next().value!);
    const stepUpId = randomBytes(32).toString("base64url");
    const expiresAt = now + STEP_UP_TTL_MS;
    this.issued.set(stepUpId, { binding, expiresAt });
    return { stepUpId, expiresAt };
  }

  /** Spends `id`, whatever it is presented for: true only for its own request, in time. */
  take(id: string, binding: string): boolean {
    const value = this.issued.get(id);
    this.issued.delete(id);
    return value !== undefined && value.binding === binding && value.expiresAt > this.now();
  }
}

/**
 * Whether this session's loosening actions will ask for a step-up, for a page to say so on the
 * button. Labels only: `requireStepUp` still checks every guarded request on its own.
 */
export function stepUpRequired(c: Context<AppEnv>): boolean {
  return c.get("stepUps")?.required(c) ?? false;
}

function binding(
  c: Context<AppEnv>,
  request: { method: string; path: string; bodySha256: string },
): string {
  return gatewayPasskeyStepUpBinding({ ...request, deviceId: requester(c.get("auth")) });
}

function unavailable(source: StepUpSource): HttpError {
  if (source.enrollment()?.securityLock?.())
    return new HttpError(
      403,
      "STEP_UP_UNAVAILABLE",
      "Security lock is on. This change can only be made on the computer running Omnesis right now.",
      { reason: "security-lock" },
    );
  return new HttpError(
    403,
    "STEP_UP_UNAVAILABLE",
    "This action needs your passkey, which can't be used on this gateway right now. Do it on the gateway itself.",
  );
}

/**
 * Guards one route. `exempt` sees the JSON body (and the request) and says whether this request
 * adds no access (a deny, "ask me first", a phone's own notification credential); anything it does
 * not recognise needs a step-up.
 */
export function requireStepUp(
  exempt?: (body: unknown, c: Context<AppEnv>) => boolean,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const stepUps = c.get("stepUps");
    if (!stepUps?.required(c)) return next();
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (exempt && JSON_CONTENT_TYPE.test(c.req.header("content-type") ?? "")) {
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        body = undefined;
      }
      if (exempt(body, c)) return next();
    }
    if (!stepUps.available()) throw unavailable(stepUps.source);
    const url = new URL(c.req.url);
    const request = {
      method: c.req.method.toUpperCase(),
      path: url.pathname + url.search,
      bodySha256: sha256Hex(bytes),
    };
    const presented = c.req.header(STEP_UP_HEADER);
    if (!presented || !stepUps.take(presented, binding(c, request)))
      throw new HttpError(
        428,
        "STEP_UP_REQUIRED",
        "Confirm this action with your passkey on the gateway's own page first.",
        { ...request, options: "/admin/step-up/options", header: STEP_UP_HEADER },
      );
    return next();
  };
}

const stepUpRequest = z
  .object({
    method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().startsWith("/").max(2048),
    bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const stepUpAssertion = z
  .object({ ...stepUpRequest.shape, proof: gatewayPasskeySignInProofSchema })
  .strict();

/**
 * Installs step-up on `app`: the id store every guarded route reads, and the two routes that
 * hand out an id. Mount it before any guarded route. Until the owner confirms a passkey on a
 * linked account no request requires one, and every guarded route behaves as without it.
 */
export function mountStepUp(app: RouteApp, source: StepUpSource): void {
  const stepUps = new StepUps(source);
  app.use("*", async (c, next) => {
    c.set("stepUps", stepUps);
    await next();
  });
  const bounded = bodyLimit({ maxSize: 16_384 });
  // The ceremony for one request, run on the gateway's own page.
  app.post("/admin/step-up/options", scope.admin(), bounded, validateJson(stepUpRequest), (c) => {
    c.header("Cache-Control", "no-store");
    const ceremony = source.enrollment()?.stepUpCeremony?.(binding(c, c.req.valid("json")));
    if (!ceremony) throw unavailable(source);
    return c.json(ceremony);
  });
  // The assertion for it, exchanged for an id the request then carries.
  app.post("/admin/step-up", scope.admin(), bounded, validateJson(stepUpAssertion), async (c) => {
    c.header("Cache-Control", "no-store");
    const { proof, ...request } = c.req.valid("json");
    const value = binding(c, request);
    if (!(await source.enrollment()?.verifyStepUp?.(proof, value)))
      throw new HttpError(
        403,
        "STEP_UP_REFUSED",
        "That passkey can't approve changes here. Use the passkey you set up for this gateway.",
      );
    return c.json(stepUps.issue(value));
  });
}
