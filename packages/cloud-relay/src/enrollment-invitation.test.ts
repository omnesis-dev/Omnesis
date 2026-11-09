// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { afterEach, expect, test, vi } from "vitest";
import { RelaySessions } from "./identity.js";

const origin = "https://relay.example.test";
afterEach(() => vi.useRealTimers());
test("operator invitations bind token purpose, UUID, recipient and a bounded lifetime without granting routing sessions", async () => {
  const secret = randomBytes(32);
  const sessions = new RelaySessions(secret);
  const gateway = randomUUID();
  const invitation = await sessions.issueEnrollmentInvitation(gateway.toUpperCase(), `${origin}/`);
  await sessions.verifyEnrollmentInvitation(invitation, gateway, origin);
  await expect(sessions.verify(invitation)).rejects.toThrow();
  await expect(
    sessions.verifyEnrollmentInvitation(invitation, randomUUID(), origin),
  ).rejects.toThrow("does not match");
  await expect(
    sessions.verifyEnrollmentInvitation(invitation, gateway, "https://evil.example.test"),
  ).rejects.toThrow("does not match");
  await expect(
    new RelaySessions(randomBytes(32)).verifyEnrollmentInvitation(invitation, gateway, origin),
  ).rejects.toThrow();
  const routing = await sessions.issue({
    issuer: "test",
    subject: "test",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  await expect(
    sessions.verifyEnrollmentInvitation(routing.token, gateway, origin),
  ).rejects.toThrow();
  for (const ttl of [0, -1, 3601, 1.2, NaN])
    await expect(sessions.issueEnrollmentInvitation(gateway, origin, ttl)).rejects.toThrow(
      "lifetime",
    );
  await expect(sessions.issueEnrollmentInvitation("invalid", origin)).rejects.toThrow();
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    purpose: "gateway-enrollment-v2",
    gatewayId: gateway,
    relayOrigin: origin,
    iat: now,
    exp: now + 3600,
  };
  for (const patch of [
    { purpose: "relay-routing-v1" },
    { exp: now + 3601 },
    { gatewayId: gateway.toUpperCase() },
    { relayOrigin: `${origin}/` },
    { iat: now + 60 },
  ]) {
    const forged = await new SignJWT({ ...claims, ...patch })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("omnesis-cloud-relay")
      .setAudience("omnesis-gateway-enrollment-v2")
      .sign(secret);
    await expect(sessions.verifyEnrollmentInvitation(forged, gateway, origin)).rejects.toThrow();
  }
  vi.useFakeTimers({ toFake: ["Date"], now: (now + 3601) * 1000 });
  await expect(sessions.verifyEnrollmentInvitation(invitation, gateway, origin)).rejects.toThrow();
});
