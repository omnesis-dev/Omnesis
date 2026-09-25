// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * WebSocket protocol envelope for gateway ↔ device communication.
 *
 * Two layers live here:
 *   - This file defines the **envelope shape** (command / response / event)
 *     and is intentionally type-agnostic over `Type`/`Payload`. Both ends
 *     speak the same envelope but the type universe is set by the registry.
 *   - `ws-messages.ts` defines the **typed registry** of every known message
 *     type with its request, response and event payload schemas. Producers
 *     and consumers should reach for `makeTypedCommand` / `parseRequestPayload`
 *     / `parseEventPayload` from `ws-messages.ts` — those carry full
 *     compile-time inference and zod-validated payloads.
 *
 * The loose `<T = unknown>` generic on `makeCommand` etc. is retained for
 * the small handful of low-level call sites that build envelopes for the
 * type-erased pending-response map.
 */

import type { Brand } from "@omnesis/types";

/** Correlation ID used to match a response to its originating command. */
export type WsCorrelationId = Brand<string, "WsCorrelationId">;

export function WsCorrelationId(s: string): WsCorrelationId {
  return s as WsCorrelationId;
}

/**
 * Generate a new correlation ID. Uses crypto.randomUUID (widely available in
 * Bun, Node 18+, modern browsers).
 */
export function newCorrelationId(): WsCorrelationId {
  return WsCorrelationId(crypto.randomUUID());
}

/**
 * A command expects a single matching response with the same correlation ID.
 * `type` identifies the command (e.g. "source.add").
 */
export interface WsCommand<Type extends string = string, Payload = unknown> {
  kind: "command";
  id: WsCorrelationId;
  type: Type;
  payload: Payload;
}

/**
 * Response to a command. `correlationId` matches the originating command's id.
 * On success, `result` holds the payload. On failure, `error` holds a
 * short machine-readable `code` and a human-readable `message`.
 */
export interface WsResponseOk<Result = unknown> {
  kind: "response";
  correlationId: WsCorrelationId;
  ok: true;
  result: Result;
}

export interface WsResponseErr {
  kind: "response";
  correlationId: WsCorrelationId;
  ok: false;
  error: { code: string; message: string };
}

export type WsResponse<Result = unknown> = WsResponseOk<Result> | WsResponseErr;

/**
 * One-way event. No correlation; the receiver should not reply.
 * `type` identifies the event (e.g. "sync.status").
 */
export interface WsEvent<Type extends string = string, Payload = unknown> {
  kind: "event";
  type: Type;
  payload: Payload;
}

/** Union of all envelope shapes. */
export type WsEnvelope<Type extends string = string, Payload = unknown, Result = unknown> =
  | WsCommand<Type, Payload>
  | WsResponse<Result>
  | WsEvent<Type, Payload>;

// ─── Type guards ────────────────────────────────────────────────────────────

export function isWsCommand(e: unknown): e is WsCommand {
  return (
    isPlainObject(e) &&
    e.kind === "command" &&
    typeof e.id === "string" &&
    typeof e.type === "string"
  );
}

export function isWsResponse(e: unknown): e is WsResponse {
  if (!isPlainObject(e) || e.kind !== "response" || typeof e.correlationId !== "string")
    return false;
  if (e.ok === true) return "result" in e;
  if (e.ok === false)
    return (
      isPlainObject(e.error) &&
      typeof e.error.code === "string" &&
      typeof e.error.message === "string"
    );
  return false;
}

export function isWsEvent(e: unknown): e is WsEvent {
  return isPlainObject(e) && e.kind === "event" && typeof e.type === "string";
}

export function isWsEnvelope(e: unknown): e is WsEnvelope {
  return isWsCommand(e) || isWsResponse(e) || isWsEvent(e);
}

// ─── Constructors ────────────────────────────────────────────────────────────

export function makeCommand<Type extends string, Payload>(
  type: Type,
  payload: Payload,
): WsCommand<Type, Payload> {
  return { kind: "command", id: newCorrelationId(), type, payload };
}

export function makeResponseOk<Result>(
  correlationId: WsCorrelationId,
  result: Result,
): WsResponseOk<Result> {
  return { kind: "response", correlationId, ok: true, result };
}

/**
 * The response code a device replies with when it refused a command's input,
 * rather than failing to carry the command out. The gateway answers the HTTP
 * caller that relayed the command with a 400 carrying the device's message,
 * because the fix is in what was sent, not in the device.
 */
export const WS_INVALID_INPUT = "invalid_input";

/** Thrown by a command handler whose input it refuses; see `WS_INVALID_INPUT`. */
export class WsInvalidInputError extends Error {
  readonly code = WS_INVALID_INPUT;
  constructor(message: string) {
    super(message);
    this.name = "WsInvalidInputError";
  }
}

export function makeResponseErr(
  correlationId: WsCorrelationId,
  code: string,
  message: string,
): WsResponseErr {
  return { kind: "response", correlationId, ok: false, error: { code, message } };
}

export function makeEvent<Type extends string, Payload>(
  type: Type,
  payload: Payload,
): WsEvent<Type, Payload> {
  return { kind: "event", type, payload };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
