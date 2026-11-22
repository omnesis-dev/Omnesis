// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A request body that stopped arriving before it was complete.
 *
 * A phone that iOS suspends in the middle of an upload leaves the gateway
 * with part of a JSON body. Hono's JSON validator reads what arrived, fails
 * to parse it and throws `HTTPException(400, "Malformed JSON in request
 * body")`; a chunked body that ends early surfaces as a bare `aborted`
 * stream error instead. Both used to reach the client as a refusal (400) or
 * an internal error (500), and a client that trusts a 400 as a verdict on
 * its payload eventually sets a perfectly good batch aside for good.
 *
 * The distinction is made on the transport, never on the bytes: Node marks
 * an `IncomingMessage` (and an HTTP/2 compat request) `complete` only once
 * the whole message — every byte the `Content-Length` declared, or the final
 * chunk — has been received. A body that parses badly after arriving whole
 * is still malformed and still a 400; only a body that never arrived whole
 * is answered with 408, the status clients already treat as "send it again".
 */
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";

export const REQUEST_BODY_INCOMPLETE = "REQUEST_BODY_INCOMPLETE";

const MALFORMED_JSON_MESSAGE = "Malformed JSON in request body";

interface IncomingLike {
  complete?: unknown;
}

/** The Node request behind a Hono context, when there is one. */
function incomingOf(c: Context): IncomingLike | undefined {
  const env = c.env as { incoming?: IncomingLike } | undefined;
  return env?.incoming;
}

/**
 * True when this error was caused by a body that stopped arriving.
 *
 * Only two errors qualify, and only when the transport confirms the message
 * never completed: the JSON validator's parse failure, and the stream error
 * a body read gets when its connection ends mid-body. Any other error —
 * an auth refusal thrown before the body was read, say — leaves the message
 * incomplete too, and is not a truncation.
 */
export function isIncompleteRequestBody(c: Context, err: unknown): boolean {
  const incoming = incomingOf(c);
  if (!incoming || incoming.complete !== false) return false;
  if (err instanceof HTTPException) {
    return err.status === 400 && err.message === MALFORMED_JSON_MESSAGE;
  }
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return (
      err.message === "aborted" || code === "ECONNRESET" || code === "ERR_STREAM_PREMATURE_CLOSE"
    );
  }
  return false;
}

/** The 408 a truncated body earns; clients retry it rather than discard it. */
export function incompleteRequestBodyResponse(c: Context): Response {
  return c.json(
    {
      error: "The request body ended before it was complete; send it again",
      code: REQUEST_BODY_INCOMPLETE,
    },
    408,
    { Connection: "close" },
  );
}
