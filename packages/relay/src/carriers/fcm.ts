// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

import { FCM_WAKE_DATA } from "@omnesis/core/push";

import { parseFcmServiceAccount, type FcmServiceAccount } from "../credentials.js";
import { CarrierDispatchError, systemClock } from "../types.js";
import { CarrierHealthTracker } from "./health.js";
import type { CarrierHealth, Clock, RelayCarrier, RelayTarget } from "../types.js";

const GOOGLE_FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DEFAULT_FCM_BASE_URL = "https://fcm.googleapis.com";
const MAX_RESPONSE_BYTES = 64 * 1024;

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface FcmRelayCarrierOptions {
  serviceAccountPath: string;
  appIds: readonly string[];
  baseUrl?: string;
  fetchFn?: FetchFn;
  clock?: Clock;
  requestTimeoutMs?: number;
}

export class FcmRelayCarrier implements RelayCarrier {
  readonly platform = "android" as const;
  private readonly appIds: ReadonlySet<string>;
  private readonly fetchFn: FetchFn;
  private readonly clock: Clock;
  private readonly tracker: CarrierHealthTracker;
  private accountPromise: Promise<FcmServiceAccount> | null = null;
  private accessToken: { value: string; expiresAt: number } | null = null;
  private accessTokenPromise: Promise<string> | null = null;

  constructor(private readonly opts: FcmRelayCarrierOptions) {
    this.appIds = new Set(opts.appIds);
    this.fetchFn = opts.fetchFn ?? fetch;
    this.clock = opts.clock ?? systemClock;
    this.tracker = new CarrierHealthTracker(this.clock);
  }

  covers(appId: string): boolean {
    return this.appIds.has(appId);
  }

  async sendChallenge(target: RelayTarget, nonce: string): Promise<void> {
    if (target.platform !== "android") throw new Error("FCM carrier requires an Android target");
    await this.send(target, { kind: "relay-enrol-challenge", nonce });
  }

  async sendWake(target: RelayTarget): Promise<void> {
    if (target.platform !== "android") throw new Error("FCM carrier requires an Android target");
    await this.send(target, FCM_WAKE_DATA);
  }

  health(): CarrierHealth {
    return this.tracker.snapshot();
  }

  async dispose(): Promise<void> {}

  private async send(
    target: Extract<RelayTarget, { platform: "android" }>,
    data: Readonly<Record<string, string>>,
  ): Promise<void> {
    if (!this.covers(target.appId)) throw new Error("FCM credential does not cover app identity");
    try {
      const account = await this.getServiceAccount();
      const baseUrl = (this.opts.baseUrl ?? DEFAULT_FCM_BASE_URL).replace(/\/+$/, "");
      const response = await this.fetchFn(
        `${baseUrl}/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${await this.getAccessToken(account)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token: target.token,
              data,
              android: { priority: "high" },
            },
          }),
          signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 15_000),
        },
      );
      const responseBody = await boundedText(response);
      if (!response.ok) {
        throw classifyFcmRejection(responseBody);
      }
      this.tracker.success();
    } catch (err) {
      this.tracker.failure();
      throw err instanceof CarrierDispatchError ? err : new CarrierDispatchError("other");
    }
  }

  private getServiceAccount(): Promise<FcmServiceAccount> {
    this.accountPromise ??= readFile(this.opts.serviceAccountPath, "utf8")
      .then(parseFcmServiceAccount)
      .catch((err) => {
        this.accountPromise = null;
        throw err;
      });
    return this.accountPromise;
  }

  private async getAccessToken(account: FcmServiceAccount): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt - 60_000 > this.clock.now()) {
      return this.accessToken.value;
    }
    this.accessTokenPromise ??= this.refreshAccessToken(account)
      .catch(() => {
        throw new CarrierDispatchError("credential_mint_failed");
      })
      .finally(() => {
        this.accessTokenPromise = null;
      });
    return await this.accessTokenPromise;
  }

  private async refreshAccessToken(account: FcmServiceAccount): Promise<string> {
    const issuedAt = Math.floor(this.clock.now() / 1000);
    const tokenUri = account.token_uri ?? DEFAULT_TOKEN_URI;
    const response = await this.fetchFn(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signServiceAccountJwt(account, issuedAt),
      }).toString(),
      signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 15_000),
    });
    const responseBody = await boundedText(response);
    if (!response.ok) throw new Error(`FCM OAuth returned HTTP ${response.status}`);
    const parsed = parseJsonObject(responseBody);
    const value = typeof parsed?.access_token === "string" ? parsed.access_token : null;
    if (!value) throw new Error("FCM OAuth response did not include access_token");
    const expiresIn = typeof parsed?.expires_in === "number" ? parsed.expires_in : 3600;
    this.accessToken = {
      value,
      expiresAt: this.clock.now() + Math.max(60, expiresIn) * 1000,
    };
    return value;
  }
}

function classifyFcmRejection(body: string): CarrierDispatchError {
  const error = parseJsonObject(body)?.error;
  const details = parseJsonObject(error)?.details;
  if (Array.isArray(details)) {
    const stale = details.some((detail) => parseJsonObject(detail)?.errorCode === "UNREGISTERED");
    if (stale) return new CarrierDispatchError("stale_credential", "unregistered");
  }
  return new CarrierDispatchError("other");
}

function signServiceAccountJwt(account: FcmServiceAccount, issuedAt: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: account.client_email,
      scope: GOOGLE_FCM_SCOPE,
      aud: account.token_uri ?? DEFAULT_TOKEN_URI,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  ).toString("base64url");
  const unsigned = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(account.private_key).toString("base64url")}`;
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("carrier response exceeded maximum size");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("carrier response exceeded maximum size");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return parseJsonObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
