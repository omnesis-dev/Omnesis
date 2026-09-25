// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createSign } from "node:crypto";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";

const APP_STORE_CONNECT_BASE_URL = "https://api.appstoreconnect.apple.com";
const MAX_APP_STORE_CONNECT_RESPONSE_BYTES = 1024 * 1024;

export interface AppStoreConnectCredentials {
  keyId: string;
  issuerId: string;
  privateKeyPath: string;
}

export interface EnsurePushCapabilityInput {
  bundleId: string;
  credentials: AppStoreConnectCredentials;
}

export interface EnsurePushCapabilityDeps {
  fetch?: typeof fetch;
  readPrivateKey?: (path: string) => Promise<string>;
  now?: () => number;
}

export type EnsurePushCapabilityResult = "already-enabled" | "enabled";

/** Verify an exact App ID record and enable Push Notifications when absent. */
export async function ensureAppIdPushCapability(
  input: EnsurePushCapabilityInput,
  deps: EnsurePushCapabilityDeps = {},
): Promise<EnsurePushCapabilityResult> {
  validateAppStoreConnectInput(input);
  const readPrivateKey = deps.readPrivateKey ?? ((path: string) => readFile(path, "utf8"));
  const keyPem = await readPrivateKey(input.credentials.privateKeyPath);
  const token = createAppStoreConnectJwt(
    input.credentials.keyId,
    input.credentials.issuerId,
    keyPem,
    deps.now?.() ?? Date.now(),
  );
  const request = createAppStoreConnectRequest(deps.fetch ?? fetch, token);
  const bundleUrl = new URL("/v1/bundleIds", APP_STORE_CONNECT_BASE_URL);
  bundleUrl.searchParams.set("filter[identifier]", input.bundleId);
  bundleUrl.searchParams.set("limit", "2");
  const bundleResponse = await request("GET", bundleUrl.toString());
  const matches = readResourceArray(bundleResponse);
  if (matches.length !== 1 || typeof matches[0]?.id !== "string") {
    throw new Error(
      matches.length === 0
        ? `App Store Connect has no App ID for ${input.bundleId}`
        : `App Store Connect returned multiple App IDs for ${input.bundleId}`,
    );
  }
  const appIdRecord = matches[0].id;
  const capabilityResponse = await request(
    "GET",
    `${APP_STORE_CONNECT_BASE_URL}/v1/bundleIds/${encodeURIComponent(appIdRecord)}/bundleIdCapabilities`,
  );
  const capabilities = readResourceArray(capabilityResponse);
  const hasPush = capabilities.some(
    (resource) => resource.attributes?.capabilityType === "PUSH_NOTIFICATIONS",
  );
  if (hasPush) return "already-enabled";

  await request("POST", `${APP_STORE_CONNECT_BASE_URL}/v1/bundleIdCapabilities`, {
    data: {
      type: "bundleIdCapabilities",
      attributes: { capabilityType: "PUSH_NOTIFICATIONS" },
      relationships: { bundleId: { data: { type: "bundleIds", id: appIdRecord } } },
    },
  });
  return "enabled";
}

export function createAppStoreConnectJwt(
  keyId: string,
  issuerId: string,
  keyPem: string,
  nowMs: number,
): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: issuerId,
      iat: issuedAt,
      exp: issuedAt + 19 * 60,
      aud: "appstoreconnect-v1",
    }),
  );
  const signer = createSign("SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  const signature = signer.sign({ key: keyPem, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${base64url(signature)}`;
}

interface AppStoreConnectResource {
  id?: unknown;
  attributes?: { capabilityType?: unknown };
}

function readResourceArray(value: unknown): AppStoreConnectResource[] {
  if (!value || typeof value !== "object" || !("data" in value)) {
    throw new Error("App Store Connect returned an invalid response");
  }
  const data = (value as { data: unknown }).data;
  if (!Array.isArray(data)) throw new Error("App Store Connect returned an invalid response");
  return data as AppStoreConnectResource[];
}

function createAppStoreConnectRequest(fetchFn: typeof fetch, token: string) {
  return async (method: "GET" | "POST", url: string, body?: unknown): Promise<unknown> => {
    const response = await fetchFn(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_APP_STORE_CONNECT_RESPONSE_BYTES) {
      throw new Error("App Store Connect returned an oversized response");
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_APP_STORE_CONNECT_RESPONSE_BYTES) {
      throw new Error("App Store Connect returned an oversized response");
    }
    if (!response.ok) {
      throw new Error(`App Store Connect ${method} ${response.status}: ${text.slice(0, 512)}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("App Store Connect returned invalid JSON");
    }
  };
}

function validateAppStoreConnectInput(input: EnsurePushCapabilityInput): void {
  if (!/^[A-Z0-9]{10}$/i.test(input.credentials.keyId)) {
    throw new Error("App Store Connect key id must be 10 letters or digits");
  }
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.credentials.issuerId)) {
    throw new Error("App Store Connect issuer id must be a UUID");
  }
  if (!/^[A-Za-z0-9.-]{3,255}$/.test(input.bundleId)) {
    throw new Error("bundle id is invalid");
  }
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export interface FirebaseClientValues {
  packageId: string;
  applicationId: string;
  apiKey: string;
  projectId: string;
  senderId: string;
}

const FIREBASE_PROPERTY_KEYS: ReadonlyArray<[keyof FirebaseClientValues, string]> = [
  ["packageId", "OMNESIS_ANDROID_APPLICATION_ID"],
  ["applicationId", "OMNESIS_FIREBASE_APPLICATION_ID"],
  ["apiKey", "OMNESIS_FIREBASE_API_KEY"],
  ["projectId", "OMNESIS_FIREBASE_PROJECT_ID"],
  ["senderId", "OMNESIS_FIREBASE_SENDER_ID"],
];

/** Render the machine-local Android build inputs without a google-services.json. */
export function renderFirebaseLocalPushProperties(values: FirebaseClientValues): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(values.packageId.trim())) {
    throw new Error("Android package id is invalid");
  }
  return [
    "# Generated by `omnesis push setup`. Do not commit this file.",
    ...FIREBASE_PROPERTY_KEYS.map(([field, property]) => {
      const value = values[field].trim();
      if (!value) throw new Error(`${property} is required`);
      return `${property}=${escapeJavaProperty(value)}`;
    }),
    "",
  ].join("\n");
}

export async function writeFirebaseLocalPushProperties(
  path: string,
  values: FirebaseClientValues,
): Promise<void> {
  const existing = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw new Error("refusing to overwrite a symbolic-link local.push.properties");
  }
  await writeFile(path, renderFirebaseLocalPushProperties(values), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

function escapeJavaProperty(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("=", "\\=")
    .replaceAll(":", "\\:");
}
