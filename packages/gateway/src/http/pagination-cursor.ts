// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { BadRequestError, HttpError } from "./errors.js";

const CURSOR_VERSION = 1;

interface CursorEnvelope {
  v: typeof CURSOR_VERSION;
  scope: string;
  payload: unknown;
}

/**
 * Encode endpoint-owned pagination state into an opaque cursor.
 *
 * `scope` is deliberately part of the wire envelope: a cursor issued by one
 * list (or one differently-filtered view of a list) must never be accepted by
 * another merely because their payloads happen to have the same shape.
 */
export function encodePageCursor<T>(scope: string, payload: T): string {
  const envelope: CursorEnvelope = { v: CURSOR_VERSION, scope, payload };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

/**
 * Decode and validate an opaque pagination cursor.
 *
 * The endpoint supplies the payload parser because its keyset is domain
 * specific. Any malformed, version-mismatched, cross-scope, or invalid-payload
 * cursor is a caller error and therefore maps to the gateway's canonical 400
 * envelope rather than leaking a JSON/base64 exception as a 500.
 */
export function decodePageCursor<T>(
  raw: string | null | undefined,
  scope: string,
  parsePayload: (payload: unknown) => T | null,
): T | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!isCursorEnvelope(parsed) || parsed.v !== CURSOR_VERSION || parsed.scope !== scope) {
      throw new Error("cursor envelope mismatch");
    }
    const payload = parsePayload(parsed.payload);
    if (payload === null) throw new Error("invalid cursor payload");
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new BadRequestError("Invalid pagination cursor");
  }
}

function isCursorEnvelope(value: unknown): value is CursorEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.v === CURSOR_VERSION &&
    typeof candidate.scope === "string" &&
    Object.prototype.hasOwnProperty.call(candidate, "payload")
  );
}
