// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createLogger } from "@omnesis/core";
import { FCM_WAKE_DATA } from "@omnesis/core/push";

import type { FcmConfig, FcmSendResult, FcmWake } from "./fcm-types.js";

const log = createLogger("gateway:fcm:client");
const GOOGLE_FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DEFAULT_FCM_BASE_URL = "https://fcm.googleapis.com";
export const DEFAULT_FCM_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_FCM_RESPONSE_BYTES = 64 * 1_024;

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface FcmClientOptions {
  config: FcmConfig;
  fetchFn?: FetchFn;
  now?: () => number;
  requestTimeoutMs?: number;
}

export class FcmClient {
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private accountPromise: Promise<ServiceAccount> | null = null;
  private accessToken: { value: string; expiresAtMs: number } | null = null;
  private accessTokenPromise: Promise<string> | null = null;

  constructor(private readonly opts: FcmClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Identity covered by the configured service account, used by push-plan. */
  async projectId(): Promise<string> {
    const account = await this.getServiceAccount();
    return this.opts.config.projectId ?? account.project_id;
  }

  async send(notification: FcmWake): Promise<FcmSendResult> {
    return this.sendData(notification.registrationToken, FCM_WAKE_DATA);
  }

  private async sendData(
    registrationToken: string,
    data: Record<string, string>,
  ): Promise<FcmSendResult> {
    const account = await this.getServiceAccount();
    const projectId = this.opts.config.projectId ?? account.project_id;
    const baseUrl = (this.opts.config.baseUrl ?? DEFAULT_FCM_BASE_URL).replace(/\/$/, "");
    const response = await this.fetchFn(
      `${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.getAccessToken(account)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: registrationToken,
            data,
            android: { priority: "high" },
          },
        }),
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? DEFAULT_FCM_REQUEST_TIMEOUT_MS),
      },
    );
    const rawBody = await readBoundedBody(response);
    if (response.ok) {
      return { ok: true, name: parseMessageName(rawBody) };
    }
    const reason = parseFcmReason(rawBody, response.statusText);
    return {
      ok: false,
      statusCode: response.status,
      reason,
      unregistered: reason === "UNREGISTERED",
    };
  }

  private async getAccessToken(account: ServiceAccount): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAtMs - 60_000 > this.now()) {
      return this.accessToken.value;
    }
    if (this.accessTokenPromise) return this.accessTokenPromise;
    this.accessTokenPromise = this.refreshAccessToken(account).finally(() => {
      this.accessTokenPromise = null;
    });
    return this.accessTokenPromise;
  }

  private async refreshAccessToken(account: ServiceAccount): Promise<string> {
    const issuedAt = Math.floor(this.now() / 1000);
    const assertion = signServiceAccountJwt(account, issuedAt);
    const response = await this.fetchFn(account.token_uri ?? DEFAULT_TOKEN_URI, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? DEFAULT_FCM_REQUEST_TIMEOUT_MS),
    });
    const rawBody = await readBoundedBody(response);
    if (!response.ok) {
      throw new Error(`FCM OAuth token exchange failed with HTTP ${response.status}`);
    }
    const parsed = parseJsonObject(rawBody);
    const token = typeof parsed?.access_token === "string" ? parsed.access_token : null;
    const expiresIn = typeof parsed?.expires_in === "number" ? parsed.expires_in : 3600;
    if (!token) throw new Error("FCM OAuth response did not include access_token");
    this.accessToken = {
      value: token,
      expiresAtMs: this.now() + Math.max(60, expiresIn) * 1000,
    };
    return token;
  }

  private getServiceAccount(): Promise<ServiceAccount> {
    if (!this.accountPromise) {
      this.accountPromise = readFile(this.opts.config.serviceAccountPath, "utf8")
        .then(parseServiceAccount)
        .catch((err) => {
          this.accountPromise = null;
          log.warn(
            `failed to load FCM service account: ${err instanceof Error ? err.message : String(err)}`,
          );
          throw err;
        });
    }
    return this.accountPromise;
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FCM_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("FCM response exceeded the maximum size");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_FCM_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("FCM response exceeded the maximum size");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function parseServiceAccount(raw: string): ServiceAccount {
  const parsed = parseJsonObject(raw);
  if (
    typeof parsed?.client_email !== "string" ||
    typeof parsed.private_key !== "string" ||
    typeof parsed.project_id !== "string" ||
    (parsed.token_uri !== undefined && typeof parsed.token_uri !== "string")
  ) {
    throw new Error("FCM service-account file is missing required fields");
  }
  return parsed as unknown as ServiceAccount;
}

function signServiceAccountJwt(account: ServiceAccount, issuedAt: number): string {
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const claims = base64UrlJson({
    iss: account.client_email,
    scope: GOOGLE_FCM_SCOPE,
    aud: account.token_uri ?? DEFAULT_TOKEN_URI,
    iat: issuedAt,
    exp: issuedAt + 3600,
  });
  const unsigned = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(account.private_key).toString("base64url")}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function parseMessageName(raw: string): string | null {
  const parsed = parseJsonObject(raw);
  return typeof parsed?.name === "string" ? parsed.name : null;
}

function parseFcmReason(raw: string, fallback: string): string {
  const parsed = parseJsonObject(raw);
  const error = parseJsonObject(parsed?.error);
  if (Array.isArray(error?.details)) {
    for (const detail of error.details) {
      const obj = parseJsonObject(detail);
      if (typeof obj?.errorCode === "string") return obj.errorCode;
    }
  }
  return typeof error?.status === "string" ? error.status : fallback || "FCM_ERROR";
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
