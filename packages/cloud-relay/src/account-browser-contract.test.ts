// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import {
  ACCOUNT_BROWSER_PROTOCOL,
  accountBrowserCallback,
  accountBrowserTranscript,
  accountBrowserUnsigned,
} from "./account-browser-contract.js";

const origin = "https://relay.example.test";
test("account handoff callbacks and transcripts bind exact purpose, origin, challenge and redemption capability", () => {
  const owner = {
    ownerAccountId: "a".repeat(64),
    gatewayId: randomUUID(),
    publicOrigin: "https://gateway.example.test",
    tlsSpkiFingerprint: "b".repeat(64),
    ownerPublicKey: "synthetic-public-key",
  };
  const now = Math.floor(Date.now() / 1000);
  const request = {
    protocol: ACCOUNT_BROWSER_PROTOCOL,
    operationId: randomUUID(),
    purpose: "owner-link" as const,
    nonce: randomBytes(32).toString("base64url"),
    callbackUrl: "https://gateway.example.test/admin/cloud-relay/account/callback",
    browserState: randomBytes(32).toString("base64url"),
    redemptionSha256: "c".repeat(64),
    issuedAt: now,
    expiresAt: now + 120,
  };
  const transcript = accountBrowserTranscript(origin, owner, request).toString();
  expect(transcript).toContain("omnesis-account-browser-start-v3");
  expect(
    accountBrowserTranscript("https://other.example.test", owner, request).toString(),
  ).not.toBe(transcript);
  expect(
    accountBrowserTranscript(origin, { ...owner, gatewayId: randomUUID() }, request).toString(),
  ).not.toBe(transcript);
  expect(
    accountBrowserTranscript(origin, owner, {
      ...request,
      nonce: randomBytes(32).toString("base64url"),
    }).toString(),
  ).not.toBe(transcript);
  for (const callbackUrl of [
    "http://gateway.example.test/admin/cloud-relay/account/callback",
    "https://name@gateway.example.test/admin/cloud-relay/account/callback",
    "https://name:password@gateway.example.test/admin/cloud-relay/account/callback",
    "https://gateway.example.test/admin/cloud-relay/account/callback?unexpected=1",
    "https://gateway.example.test/admin/cloud-relay/account/callback#fragment",
    "https://gateway.example.test:0/admin/cloud-relay/account/callback",
    "https://gateway.example.test/devices/account/callback",
    "https://GATEWAY.example.test/admin/cloud-relay/account/callback",
    "malformed",
  ])
    expect(accountBrowserUnsigned.safeParse({ ...request, callbackUrl }).success).toBe(false);
  for (const expiresAt of [now, now + 301])
    expect(accountBrowserUnsigned.safeParse({ ...request, expiresAt }).success).toBe(false);
  expect(
    accountBrowserCallback(
      "https://local.example.test/devices/account/callback",
      "device-enrollment",
    ).hostname,
  ).toBe("local.example.test");
});
