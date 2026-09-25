// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-route request-body validation at the route boundary, backed by zod.
 *
 * Every POST/PATCH/PUT route that takes a JSON body should declare its body
 * shape as a zod schema in `http/schemas/<route>.ts` and mount the schema
 * via `validateJson(schema)`. The handler then reads the parsed value via
 * `c.req.valid("json")` — typed as `z.infer<typeof schema>` — instead of
 * `await c.req.json()`.
 *
 * Failures throw a `ValidationError`, which the central `app.onError`
 * (server.ts) renders as the canonical 400 envelope:
 *   { error: "Validation failed",
 *     code:  "VALIDATION_ERROR",
 *     detail: [{ path, message }, ...] }
 * where `path` is an RFC 6901 JSON pointer (e.g. `/sources/0/accountId`),
 * matching the convention already established by `validateConfig` in
 * `@omnesis/core/config-schema.ts`.
 *
 * Hono's `validator("json", ...)` handles malformed-JSON requests by
 * throwing `HTTPException(400, { message: "Malformed JSON in request body" })`,
 * which the gateway's central error handler renders as a 400.
 */
import { validator } from "hono/validator";
import { toJsonPointer } from "@omnesis/config";
import { ValidationError } from "./errors.js";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./routes/types.js";
import type { ZodTypeAny, z } from "zod";

/**
 * Observe the exact bytes rejected by Hono's JSON parser without changing the
 * validation response. The request clone is made before the validator consumes
 * the body; callers decide how much of the body is safe to retain in logs.
 */
export function observeMalformedJson(
  onMalformed: (body: string) => void,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.header("content-type")?.toLowerCase().includes("application/json")) {
      try {
        const body = await c.req.raw.clone().text();
        try {
          JSON.parse(body);
        } catch {
          onMalformed(body);
        }
      } catch {
        // The production validator remains authoritative for the response.
      }
    }
    await next();
  };
}

export function validateJson<S extends ZodTypeAny>(schema: S) {
  return validator("json", (value, _c) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new ValidationError(
        "Validation failed",
        result.error.issues.map((issue) => ({
          path: toJsonPointer(pointerPath(issue.path)),
          message: issue.message,
        })),
      );
    }
    return result.data as z.infer<S>;
  });
}

/**
 * Query-string sibling of {@link validateJson}: validates `c.req.query()`
 * against a zod schema (typically all-`z.coerce` fields, since every query
 * value arrives as a string). Read the parsed value via
 * `c.req.valid("query")`. Failures render the same canonical
 * VALIDATION_ERROR envelope with RFC 6901 pointers.
 */
export function validateQuery<S extends ZodTypeAny>(schema: S) {
  return validator("query", (value, _c) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new ValidationError(
        "Validation failed",
        result.error.issues.map((issue) => ({
          path: toJsonPointer(pointerPath(issue.path)),
          message: issue.message,
        })),
      );
    }
    return result.data as z.infer<S>;
  });
}

function pointerPath(path: readonly PropertyKey[]): (string | number)[] {
  return path.filter(
    (seg): seg is string | number => typeof seg === "string" || typeof seg === "number",
  );
}
