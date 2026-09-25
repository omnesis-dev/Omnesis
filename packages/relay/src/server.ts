// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isIP } from "node:net";

import { assertNever, createLogger } from "@omnesis/core";
import {
  PUSH_RELAY_PROTOCOL_VERSION,
  relayEnrolRequestSchema,
  relayVerifyRequestSchema,
  type RelayEnrolRequest,
} from "@omnesis/core/push";
import { Hono, type Context } from "hono";

import { RelayServiceError } from "./service.js";
import type { RelayService } from "./service.js";
import type { RelayTarget } from "./types.js";

const log = createLogger("relay:http");
const MAX_REQUEST_BYTES = 16 * 1024;

type RelayAppEnv = { Variables: { requestSource: string | undefined } };

/** Production app: every carrier-facing API request must have traversed Cloudflare. */
export function createRelayApp(service: RelayService): Hono<RelayAppEnv> {
  const app = new Hono<RelayAppEnv>();

  app.use("/v1/*", async (c, next) => {
    const endpoint = endpointForPath(c.req.path);
    const source = parseCloudflareSource(c.req.header("cf-connecting-ip"));
    if (!source) {
      service.observeMissingSource(endpoint);
      return invalidRequest(c, "trusted request source is required");
    }
    c.set("requestSource", source);
    return next();
  });

  app.get("/health", (c) => {
    const carriers = service.health();
    const values = [carriers.ios, carriers.android];
    const status = values.some((carrier) => carrier === null || carrier.status === "unreachable")
      ? "degraded"
      : values.every((carrier) => carrier?.status === "reachable")
        ? "ready"
        : "unknown";
    const ok = status === "ready";
    return c.json(
      {
        ok,
        status,
        protocols: {
          enrolment: [PUSH_RELAY_PROTOCOL_VERSION],
          wake: [PUSH_RELAY_PROTOCOL_VERSION],
        },
        carriers,
      },
      ok ? 200 : 503,
    );
  });

  app.post("/v1/enrol", async (c) => {
    const parsed = relayEnrolRequestSchema.safeParse(await readJsonBody(c.req.raw));
    if (!parsed.success)
      return invalidRequest(c, parsed.error.issues[0]?.message ?? "invalid body");
    try {
      const result = await service.enrol(targetFromEnrolment(parsed.data), c.get("requestSource"));
      return c.json(result, 202);
    } catch (err) {
      return serviceFailure(c, err);
    }
  });

  app.post("/v1/enrol/verify", async (c) => {
    const parsed = relayVerifyRequestSchema.safeParse(await readJsonBody(c.req.raw));
    if (!parsed.success)
      return invalidRequest(c, parsed.error.issues[0]?.message ?? "invalid body");
    try {
      return c.json(
        service.verify(parsed.data.challengeId, parsed.data.nonce, c.get("requestSource")),
        200,
      );
    } catch (err) {
      return serviceFailure(c, err);
    }
  });

  app.post("/v1/wake", async (c) => {
    const body = await readLimitedBody(c.req.raw);
    if (body.byteLength !== 0) return invalidRequest(c, "wake body must be empty");
    const authorization = c.req.header("authorization") ?? "";
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    try {
      await service.wake(match?.[1] ?? "", c.get("requestSource"));
      return c.body(null, 202);
    } catch (err) {
      return serviceFailure(c, err);
    }
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    if (err instanceof RequestBodyError) return invalidRequest(c, err.message);
    log.warn(`request failed: ${err.message}`);
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}

function parseCloudflareSource(value: string | undefined): string | null {
  if (!value || value !== value.trim() || value.includes(",") || isIP(value) === 0) return null;
  return value;
}

function endpointForPath(path: string): "enrol" | "verify" | "wake" {
  if (path === "/v1/enrol/verify") return "verify";
  if (path === "/v1/wake") return "wake";
  return "enrol";
}

function targetFromEnrolment(request: RelayEnrolRequest): RelayTarget {
  return request.platform === "ios"
    ? {
        platform: "ios",
        token: request.token,
        appId: request.bundleId,
        environment: request.environment,
      }
    : {
        platform: "android",
        token: request.token,
        appId: request.appId,
      };
}

class RequestBodyError extends Error {}

async function readJsonBody(request: Request): Promise<unknown> {
  const bytes = await readLimitedBody(request);
  if (bytes.byteLength === 0) throw new RequestBodyError("JSON body is required");
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RequestBodyError("body must be valid JSON");
  }
}

async function readLimitedBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    throw new RequestBodyError("request body is too large");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new RequestBodyError("request body is too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function invalidRequest(c: Context, message: string): Response {
  return c.json({ error: "invalid_request", message }, 400);
}

function serviceFailure(c: Context, err: unknown): Response {
  if (!(err instanceof RelayServiceError)) throw err;
  switch (err.code) {
    case "identity_not_covered":
      return c.json({ error: err.code }, 403);
    case "challenge_rejected":
    case "credential_rejected":
      return c.json({ error: err.code }, 401);
    case "rate_limited": {
      const seconds = Math.max(1, Math.ceil((err.retryAfterMs ?? 1000) / 1000));
      c.header("retry-after", String(seconds));
      return c.json({ error: err.code, retryAfterSeconds: seconds }, 429);
    }
    case "carrier_unavailable":
    case "capacity_unavailable":
      if (err.retryAfterMs !== null) {
        c.header("retry-after", String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
      }
      return c.json({ error: err.code }, 503);
    case "carrier_failed":
      return c.json({ error: err.code }, 502);
    default:
      return assertNever(err.code);
  }
}
