// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Fake Apple Push Notification service for end-to-end tests.
 *
 * Stands up a local HTTP/2 (cleartext / h2c) server that speaks just
 * enough of the APNs provider API to exercise the gateway's real
 * `Http2ApnsTransport` end-to-end — no Apple credentials, no network.
 *
 * The gateway's APNs transport connects with `node:http2.connect`,
 * which negotiates h2c when the authority is an `http://` origin, so
 * the fake serves plain HTTP/2 (no TLS). Point the gateway at it via
 * `gateway.apns.baseUrl` in `omnesis.json` or the
 * `OMNESIS_APNS_BASE_URL` env var (both accept the `url` this returns).
 *
 * Each push the gateway sends is parsed (path → device token, headers,
 * JSON body) and recorded in `received` for assertions. The server
 * replies 200 with a synthetic `apns-id` by default; pass `respond`
 * to drive error responses (e.g. 410 Unregistered to exercise the
 * runner's clear-token path).
 */

import { createServer, type Http2Server, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";

/** One push as the fake observed it on the wire. */
export interface ReceivedApnsPush {
  /** Hex device token parsed from the `/3/device/<token>` path. */
  deviceToken: string;
  /** Parsed JSON body (the APNs payload: `{ aps, omnesis }`). */
  payload: unknown;
  /** Exact request bytes received before JSON parsing. */
  body: Buffer;
  /** Request headers (apns-topic, apns-push-type, authorization, …). */
  headers: Record<string, string>;
}

/** Response the fake should return for a given push. */
export interface FakeApnsResponse {
  statusCode: number;
  /** APNs reason string, sent as `{ "reason": "<reason>" }` JSON body. */
  reason?: string;
  /** Value for the `apns-id` response header. Defaults to a synthetic id. */
  apnsId?: string;
}

export interface StartFakeApnsServerOptions {
  /**
   * Per-push response selector. Receives the parsed push and returns
   * the response the fake should send. Default: 200 OK with a
   * synthetic apns-id.
   */
  respond?: (push: ReceivedApnsPush) => FakeApnsResponse;
  /** Bind host. Defaults to 127.0.0.1. */
  host?: string;
}

export interface FakeApnsServer {
  /** `http://<host>:<port>` — feed to `apns.baseUrl` / `OMNESIS_APNS_BASE_URL`. */
  url: string;
  /** Every push received, in arrival order. */
  received: ReceivedApnsPush[];
  /** Shut the server down and resolve once all sockets are closed. */
  close: () => Promise<void>;
}

const DEVICE_PATH_RE = /^\/3\/device\/([^/?#]+)$/;

export async function startFakeApnsServer(
  opts: StartFakeApnsServerOptions = {},
): Promise<FakeApnsServer> {
  const received: ReceivedApnsPush[] = [];
  const respond = opts.respond ?? (() => ({ statusCode: 200 }) as FakeApnsResponse);
  const host = opts.host ?? "127.0.0.1";

  const server: Http2Server = createServer();

  server.on("stream", (stream: ServerHttp2Stream, rawHeaders) => {
    const path = String(rawHeaders[":path"] ?? "");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (k.startsWith(":")) continue;
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v) && v.length > 0) headers[k] = String(v[0]);
    }

    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("end", () => {
      const body = Buffer.concat(chunks);
      const bodyText = body.toString("utf8");
      let payload: unknown = bodyText;
      try {
        payload = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        // Leave payload as the raw string if it isn't JSON — the test
        // can still assert on it.
      }

      const match = DEVICE_PATH_RE.exec(path);
      const deviceToken = match ? decodeURIComponent(match[1]!) : "";
      const push: ReceivedApnsPush = { deviceToken, payload, body, headers };
      received.push(push);

      const r = respond(push);
      const respHeaders: Record<string, string | number> = {
        ":status": r.statusCode,
        "apns-id": r.apnsId ?? `fake-apns-${received.length}`,
      };
      if (r.statusCode === 200) {
        stream.respond(respHeaders);
        stream.end();
        return;
      }
      const errBody = JSON.stringify({ reason: r.reason ?? "Unknown" });
      stream.respond({ ...respHeaders, "content-type": "application/json" });
      stream.end(errBody);
    });

    stream.on("error", () => {
      // A client-side abort (e.g. transport timeout) shows up here.
      // Nothing to record; the test asserts on what was received.
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const url = `http://${host}:${addr.port}`;

  return {
    url,
    received,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
