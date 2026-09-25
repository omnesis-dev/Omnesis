// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, type ClientHttp2Session } from "node:http2";

import { APNS_WAKE_JSON } from "@omnesis/core/push";

import { CarrierDispatchError, systemClock } from "../types.js";
import { CarrierHealthTracker } from "./health.js";
import type { CarrierHealth, Clock, RelayCarrier, RelayTarget } from "../types.js";

const APNS_PRODUCTION = "https://api.push.apple.com";
const APNS_SANDBOX = "https://api.sandbox.push.apple.com";
const JWT_MAX_AGE_MS = 45 * 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export const APNS_WAKE_BYTES = Buffer.from(APNS_WAKE_JSON);

export interface ApnsRelayCarrierOptions {
  keyPath: string;
  keyId: string;
  teamId: string;
  appIds: readonly string[];
  baseUrl?: string;
  request?: ApnsRequest;
  clock?: Clock;
}

export interface ApnsRequestInput {
  authority: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface ApnsRequestOutput {
  statusCode: number;
  body: string;
}

export interface ApnsRequest {
  send(input: ApnsRequestInput): Promise<ApnsRequestOutput>;
  dispose(): Promise<void>;
}

export class ApnsRelayCarrier implements RelayCarrier {
  readonly platform = "ios" as const;
  private readonly appIds: ReadonlySet<string>;
  private readonly request: ApnsRequest;
  private readonly ownsRequest: boolean;
  private readonly clock: Clock;
  private readonly tracker: CarrierHealthTracker;
  private keyPromise: Promise<string> | null = null;
  private jwt: { token: string; mintedAt: number } | null = null;

  constructor(private readonly opts: ApnsRelayCarrierOptions) {
    this.appIds = new Set(opts.appIds);
    this.request = opts.request ?? new Http2ApnsRequest();
    this.ownsRequest = !opts.request;
    this.clock = opts.clock ?? systemClock;
    this.tracker = new CarrierHealthTracker(this.clock);
  }

  covers(appId: string): boolean {
    return this.appIds.has(appId);
  }

  async sendChallenge(target: RelayTarget, nonce: string): Promise<void> {
    if (target.platform !== "ios") throw new Error("APNs carrier requires an iOS target");
    const body = Buffer.from(
      JSON.stringify({
        aps: { "content-available": 1 },
        omnesis: { kind: "relay-enrol-challenge", nonce },
      }),
    );
    await this.send(target, body, "background", "5");
  }

  async sendWake(target: RelayTarget): Promise<void> {
    if (target.platform !== "ios") throw new Error("APNs carrier requires an iOS target");
    await this.send(target, APNS_WAKE_BYTES, "alert", "10");
  }

  health(): CarrierHealth {
    return this.tracker.snapshot();
  }

  async dispose(): Promise<void> {
    if (this.ownsRequest) await this.request.dispose();
  }

  private async send(
    target: Extract<RelayTarget, { platform: "ios" }>,
    body: Buffer,
    pushType: "alert" | "background",
    priority: "5" | "10",
  ): Promise<void> {
    if (!this.covers(target.appId)) throw new Error("APNs credential does not cover app identity");
    try {
      const authority =
        this.opts.baseUrl?.replace(/\/+$/, "") ??
        (target.environment === "production" ? APNS_PRODUCTION : APNS_SANDBOX);
      const response = await this.request.send({
        authority,
        path: `/3/device/${encodeURIComponent(target.token)}`,
        headers: {
          authorization: `bearer ${await this.mintJwt()}`,
          "apns-topic": target.appId,
          "apns-push-type": pushType,
          "apns-priority": priority,
        },
        body,
      });
      if (response.statusCode !== 200) {
        throw classifyApnsRejection(response.statusCode, response.body);
      }
      this.tracker.success();
    } catch (err) {
      this.tracker.failure();
      throw err instanceof CarrierDispatchError ? err : new CarrierDispatchError("other");
    }
  }

  private async mintJwt(): Promise<string> {
    try {
      return await this.getJwt();
    } catch {
      throw new CarrierDispatchError("credential_mint_failed");
    }
  }

  private async getJwt(): Promise<string> {
    const now = this.clock.now();
    if (this.jwt && now - this.jwt.mintedAt < JWT_MAX_AGE_MS) return this.jwt.token;
    this.keyPromise ??= readFile(this.opts.keyPath, "utf8").catch((err) => {
      this.keyPromise = null;
      throw err;
    });
    const key = await this.keyPromise;
    const token = signApnsJwt(key, this.opts.keyId, this.opts.teamId, Math.floor(now / 1000));
    this.jwt = { token, mintedAt: now };
    return token;
  }
}

function classifyApnsRejection(statusCode: number, body: string): CarrierDispatchError {
  const reason = parseJsonObject(body)?.reason;
  if (statusCode === 410 && reason === "Unregistered") {
    return new CarrierDispatchError("stale_credential", "unregistered");
  }
  if (statusCode === 400 && reason === "BadDeviceToken") {
    return new CarrierDispatchError("stale_credential", "bad_device_token");
  }
  if (statusCode === 400 && reason === "DeviceTokenNotForTopic") {
    return new CarrierDispatchError("stale_credential", "device_token_not_for_topic");
  }
  return new CarrierDispatchError("other");
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class Http2ApnsRequest implements ApnsRequest {
  private readonly sessions = new Map<string, ClientHttp2Session>();

  async send(input: ApnsRequestInput): Promise<ApnsRequestOutput> {
    const session = this.session(input.authority);
    return await new Promise<ApnsRequestOutput>((resolve, reject) => {
      const request = session.request({
        ":method": "POST",
        ":path": input.path,
        ...input.headers,
      });
      let statusCode = 0;
      let bytes = 0;
      const chunks: Buffer[] = [];
      request.setTimeout(15_000, () => request.destroy(new Error("APNs request timed out")));
      request.on("response", (headers) => {
        statusCode = Number(headers[":status"] ?? 0);
      });
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("APNs response exceeded maximum size"));
          return;
        }
        chunks.push(chunk);
      });
      request.once("error", reject);
      request.once("end", () =>
        resolve({ statusCode, body: Buffer.concat(chunks).toString("utf8") }),
      );
      request.end(input.body);
    });
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map(
        (session) =>
          new Promise<void>((resolve) => {
            if (session.destroyed || session.closed) return resolve();
            session.close(resolve);
          }),
      ),
    );
    this.sessions.clear();
  }

  private session(authority: string): ClientHttp2Session {
    const current = this.sessions.get(authority);
    if (current && !current.closed && !current.destroyed) return current;
    const session = connect(authority);
    session.on("error", () => {
      if (this.sessions.get(authority) === session) this.sessions.delete(authority);
    });
    session.on("close", () => {
      if (this.sessions.get(authority) === session) this.sessions.delete(authority);
    });
    this.sessions.set(authority, session);
    return session;
  }
}

function signApnsJwt(key: string, keyId: string, teamId: string, issuedAt: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({ iss: teamId, iat: issuedAt })).toString("base64url");
  const unsigned = `${header}.${claims}`;
  const signer = createSign("SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign({ key, dsaEncoding: "ieee-p1363" });
  return `${unsigned}.${signature.toString("base64url")}`;
}
