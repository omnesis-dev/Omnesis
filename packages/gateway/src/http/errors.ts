// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const log = createLogger("gateway:http");

/**
 * Status-code rules:
 *
 *   - 400 BadRequest             — request shape invalid (bad JSON,
 *                                    schema violation, malformed body)
 *   - 401 Unauthorized           — missing / invalid bearer token
 *   - 403 Forbidden              — token present, scope insufficient
 *   - 404 NotFound               — resource absent
 *   - 409 Conflict               — duplicate / concurrent op
 *   - 502 BadGateway             — remote dependency *rejected* the
 *                                    request (collector returned 4xx,
 *                                    OAuth provider 4xx)
 *   - 503 ServiceUnavailable     — gateway-side dep not configured at
 *                                    boot, or queue full / read-only
 *                                    (transient backpressure)
 *   - 504 GatewayTimeout         — remote dependency *timed out*
 *                                    (collector WS round-trip,
 *                                    embedder, OAuth provider)
 *   - 507 InsufficientStorage    — free disk on the DB volume is below
 *                                    the configured floor; the gateway
 *                                    refuses to write (re-sent on the
 *                                    collector's next sync)
 *
 * The route handlers should THROW one of the subclasses below rather
 * than `c.json({error: ...}, status)` directly. The single
 * `app.onError` in server.ts maps the throw → uniform envelope:
 *
 *   { error: <message>, code: <CODE>, detail?: <unknown> }
 *
 * Unhandled errors fall through to a sanitized 500
 *   { error: "Internal server error", code: "INTERNAL_ERROR",
 *     requestId: <uuid> }
 *
 * — never leaking stack or err.message to the client. Operators
 * correlate via the still-fully-logged stack on the server side.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, detail?: unknown) {
    super(400, "BAD_REQUEST", message, detail);
    this.name = "BadRequestError";
  }
}

export class ValidationError extends HttpError {
  constructor(message: string, detail?: unknown) {
    super(400, "VALIDATION_ERROR", message, detail);
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized") {
    super(401, "UNAUTHORIZED", message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "Forbidden") {
    super(403, "FORBIDDEN", message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not Found") {
    super(404, "NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, "CONFLICT", message);
    this.name = "ConflictError";
  }
}

/** A mutable ordering changed while the client was walking a keyset page. */
export class StalePageCursorError extends HttpError {
  constructor() {
    super(
      409,
      "STALE_PAGE_CURSOR",
      "The list changed while it was being paged. Restart from the first page.",
    );
    this.name = "StalePageCursorError";
  }
}

export class BadGatewayError extends HttpError {
  constructor(message: string, detail?: unknown) {
    super(502, "BAD_GATEWAY", message, detail);
    this.name = "BadGatewayError";
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(message: string, detail?: unknown) {
    super(503, "SERVICE_UNAVAILABLE", message, detail);
    this.name = "ServiceUnavailableError";
  }
}

export class GatewayTimeoutError extends HttpError {
  constructor(message: string, detail?: unknown) {
    super(504, "GATEWAY_TIMEOUT", message, detail);
    this.name = "GatewayTimeoutError";
  }
}

/**
 * 507 — the DB volume is below the configured free-disk floor, so the
 * gateway refuses to write rather than risk a partial / corrupting write.
 * The collector's sync cursor doesn't advance, so the page is re-sent on its next scheduled sync once
 * disk frees and a later attempt succeeds. See #15.
 */
export class InsufficientStorageError extends HttpError {
  constructor(message: string, detail?: unknown) {
    super(507, "INSUFFICIENT_STORAGE", message, detail);
    this.name = "InsufficientStorageError";
  }
}

/**
 * Render an `HttpError` as the canonical envelope, and log it.
 *
 * The log line is the only server-side record that a request was refused.
 * Without it a client whose pushes the gateway rejects — a phone holding an
 * undeliverable batch, a collector sending a body the schema no longer
 * accepts — retries forever against a gateway whose journal shows nothing at
 * all, and the rejection is diagnosable only from the client's own logs.
 *
 * Logged at `warn`: a thrown `HttpError` means a route deliberately refused
 * the request, which is worth an operator's attention. Responses returned
 * directly as `c.json(body, 4xx)` bypass this path; the few sites that do
 * that (the body-limit middlewares) carry their own logging.
 *
 * `detail` is what makes the line actionable — a `ValidationError` carries
 * the failing JSON pointers and zod messages
 * (`[{ path: "/records/0/start_time", message: "Required" }]`), naming the
 * field that broke. Only that shape is logged: `detail` is typed `unknown`
 * and some routes attach whole domain documents to it (the privacy-policy
 * conflict returns the current policy), which have no business in a log
 * file. Everything else is summarised as its type.
 *
 * What does reach the log, unavoidably, is the request path — and source ids
 * are path parameters, so a line can name an account (`gmail:someone@…`).
 * That is the same exposure every request log in this server already
 * carries, and it stops at the path: the query string is not logged, so
 * search terms never are.
 */
export function errorResponse(c: Context, err: HttpError) {
  const body: { error: string; code: string; detail?: unknown } = {
    error: err.message,
    code: err.code,
  };
  // `detail` is `unknown`, and this is the handler of last resort: a value
  // that cannot be serialised would throw out of `app.onError` and take the
  // response with it, turning a clean 4xx into an unhandled rejection.
  // Dropping the detail leaves the client a well-formed envelope.
  if (err.detail !== undefined && isSerializable(err.detail)) body.detail = err.detail;
  logRefusal(c, err);
  return c.json(body, err.status as ContentfulStatusCode);
}

function isSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cap on the rendered `detail`. A rejected page can carry one issue per
 * field per item — a 300-document push failing validation serialises to
 * ~180 KB, and a collector re-sending that page every sync cycle would
 * rotate the log out from under the very history it is there to preserve.
 * The first issues already name the broken field, which is the point.
 */
const MAX_DETAIL_CHARS = 512;

function logRefusal(c: Context, err: HttpError) {
  const reqId = (c.get("requestId") as string | undefined) ?? "?";
  const auth = c.get("auth") as { deviceId?: string | null } | undefined;
  const caller = auth?.deviceId ? auth.deviceId.slice(0, 8) : "no-device";
  log.warn(
    `${err.status} ${err.code} on ${c.req.method} ${c.req.path} [${caller}] [req=${reqId}]: ${err.message}${renderDetail(err.detail)}`,
  );
}

/** The `[{ path, message }]` shape `validateJson` / `validateQuery` produce. */
function isValidationDetail(detail: unknown): boolean {
  return (
    Array.isArray(detail) &&
    detail.every(
      (issue) =>
        typeof issue === "object" &&
        issue !== null &&
        typeof (issue as { path?: unknown }).path === "string" &&
        typeof (issue as { message?: unknown }).message === "string",
    )
  );
}

function renderDetail(detail: unknown): string {
  if (detail === undefined) return "";
  if (!isValidationDetail(detail)) return ` detail=<${typeof detail}>`;
  // Stringify is the last step of the last-resort error handler; a throw
  // here escapes `app.onError` and takes the request's response with it.
  let encoded: string;
  try {
    encoded = JSON.stringify(detail);
  } catch {
    return " detail=<unserializable>";
  }
  return encoded.length <= MAX_DETAIL_CHARS
    ? ` detail=${encoded}`
    : ` detail=${encoded.slice(0, MAX_DETAIL_CHARS)}…(${encoded.length - MAX_DETAIL_CHARS} more chars)`;
}
