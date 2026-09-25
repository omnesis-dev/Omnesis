// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPrivateKey } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import type { RelayConfig } from "./config.js";

export interface FcmServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

export function validateRelayCredentialFiles(config: RelayConfig): void {
  const apnsKey = readProtectedCredentialFile(config.apns.keyPath, "APNs key");
  const apnsPrivateKey = parsePrivateKey(apnsKey, "APNs key");
  if (apnsPrivateKey.asymmetricKeyType !== "ec") {
    throw new Error("APNs key must be an EC private key");
  }

  const fcmJson = readProtectedCredentialFile(
    config.fcm.serviceAccountPath,
    "FCM service-account file",
  );
  const account = parseFcmServiceAccount(fcmJson);
  const fcmPrivateKey = parsePrivateKey(account.private_key, "FCM service-account private key");
  if (fcmPrivateKey.asymmetricKeyType !== "rsa" && fcmPrivateKey.asymmetricKeyType !== "rsa-pss") {
    throw new Error("FCM service-account private key must be an RSA private key");
  }
}

export function parseFcmServiceAccount(raw: string): FcmServiceAccount {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("FCM service-account file must contain valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("FCM service-account file must contain a JSON object");
  }
  const parsed = value as Record<string, unknown>;
  if (
    !isNonEmptyString(parsed.client_email) ||
    !isNonEmptyString(parsed.private_key) ||
    !isNonEmptyString(parsed.project_id) ||
    (parsed.token_uri !== undefined && !isHttpsUrl(parsed.token_uri))
  ) {
    throw new Error("FCM service-account file is missing or has invalid required fields");
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    project_id: parsed.project_id,
    ...(parsed.token_uri === undefined ? {} : { token_uri: parsed.token_uri }),
  };
}

function readProtectedCredentialFile(path: string, label: string): string {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users`);
  }
  return readFileSync(path, "utf8");
}

function parsePrivateKey(value: string, label: string) {
  try {
    return createPrivateKey(value);
  } catch {
    throw new Error(`${label} is not a valid private key`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
