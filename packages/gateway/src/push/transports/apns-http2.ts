// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP/2 transport for direct APNs. Split out from the client so tests can
 * inject a fake without standing up a real HTTP/2 server.
 *
 * One long-lived `Http2Session` per `authority` (production /
 * sandbox); APNs handles multiple concurrent streams over the same
 * session. The session is recreated on the next send if it goes idle
 * or errors out — APNs servers close idle sessions, and a brand-new
 * connect is cheap (~1 RTT).
 */

import { connect, type ClientHttp2Session } from "node:http2";

import { createLogger, type Logger } from "@omnesis/core";

const log: Logger = createLogger("gateway:apns:transport");

export interface ApnsTransportRequest {
  /** "https://api.push.apple.com" or "https://api.sandbox.push.apple.com". */
  authority: string;
  /** "/3/device/<hex-token>". */
  path: string;
  /** Caller-supplied headers (apns-topic, apns-push-type, authorization). */
  headers: Record<string, string>;
  /** Pre-encoded JSON body. UTF-8 byte length must fit APNs' 4 KB cap. */
  body: string;
  /** Optional wall-clock deadline in ms; default 15s. */
  timeoutMs?: number;
}

export interface ApnsTransportResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Abstraction over "send an HTTP/2 POST to APNs and read the
 * response". The real implementation uses `node:http2`; tests pass a
 * fake.
 */
export interface ApnsTransport {
  request(req: ApnsTransportRequest): Promise<ApnsTransportResponse>;
  dispose(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class Http2ApnsTransport implements ApnsTransport {
  private readonly sessions = new Map<string, ClientHttp2Session>();
  private disposed = false;

  async request(req: ApnsTransportRequest): Promise<ApnsTransportResponse> {
    if (this.disposed) throw new Error("ApnsTransport is disposed");
    const session = this.getSession(req.authority);
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<ApnsTransportResponse>((resolve, reject) => {
      const stream = session.request({
        ":method": "POST",
        ":path": req.path,
        ...req.headers,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(req.body, "utf8").toString(),
      });

      let statusCode = 0;
      const respHeaders: Record<string, string> = {};
      const chunks: Buffer[] = [];

      const timeoutHandle = setTimeout(() => {
        try {
          stream.close();
        } catch {
          // best-effort; the rejection below is what surfaces.
        }
        reject(new Error(`APNs request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeoutHandle.unref();

      stream.on("response", (headers) => {
        for (const [k, v] of Object.entries(headers)) {
          if (typeof v === "string") respHeaders[k] = v;
          else if (Array.isArray(v) && v.length > 0) respHeaders[k] = v[0]!;
        }
        const code = headers[":status"];
        statusCode = typeof code === "number" ? code : Number(code ?? 0);
      });

      stream.on("data", (chunk: Buffer | string) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });

      stream.on("error", (err) => {
        clearTimeout(timeoutHandle);
        reject(err);
      });

      stream.on("end", () => {
        clearTimeout(timeoutHandle);
        resolve({
          statusCode,
          headers: respHeaders,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });

      stream.end(req.body);
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const session of this.sessions.values()) {
      try {
        session.close();
      } catch {
        // best-effort.
      }
    }
    this.sessions.clear();
  }

  private getSession(authority: string): ClientHttp2Session {
    const existing = this.sessions.get(authority);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(authority);
    session.on("error", (err) => {
      log.warn(`APNs session error for ${authority}: ${err.message}`);
      this.sessions.delete(authority);
    });
    session.on("close", () => {
      this.sessions.delete(authority);
    });
    this.sessions.set(authority, session);
    return session;
  }
}
