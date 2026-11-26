// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { desktopAccountSchema } from "./account-connect.js";
import { desktopRemoteRoute } from "./remote-route.js";
const now = 1_000_000;
function evidence() {
  return {
    publicOrigin: "https://gateway.example.test",
    account: { linked: true },
    tunnel: { state: "online" },
    certificate: { state: "valid", expiresAt: new Date(now + 200_000).toISOString() },
    publicMcp: {
      url: "https://gateway.example.test/mcp",
      ready: true,
      checkedAt: now - 1000,
      validUntil: now + 89_000,
    },
  };
}
test("only actual fresh route evidence is ready, not optional assistant setup", () => {
  const result = desktopRemoteRoute(evidence(), now);
  expect(result).toMatchObject({ state: "ready", validUntil: now + 89_000 });
  expect(JSON.stringify(result)).not.toMatch(/assistant|connected/iu);
  expect(
    desktopRemoteRoute(
      { ...evidence(), certificate: { ...evidence().certificate, state: "expiring" } },
      now,
    ).state,
  ).toBe("ready");
});
test.each([
  { ...evidence(), publicOrigin: "invalid-origin" },
  { ...evidence(), publicOrigin: "http://gateway.example.test" },
  { ...evidence(), publicMcp: { ...evidence().publicMcp, url: "https://other.example.test/mcp" } },
  { account: { linked: true } },
  { ...evidence(), tunnel: { state: "offline" } },
  { ...evidence(), certificate: { state: "expired", expiresAt: new Date(now - 1).toISOString() } },
  { ...evidence(), certificate: { state: "valid", expiresAt: "malformed" } },
  { ...evidence(), publicMcp: { url: "https://gateway.example.test/mcp", ready: true } },
  {
    ...evidence(),
    publicMcp: {
      url: "https://gateway.example.test/mcp",
      ready: false,
      checkedAt: now - 1000,
      validUntil: now + 89_000,
    },
  },
  {
    ...evidence(),
    publicMcp: {
      url: "https://gateway.example.test/mcp",
      ready: true,
      checkedAt: now + 1,
      validUntil: now + 1000,
    },
  },
  {
    ...evidence(),
    publicMcp: {
      url: "https://gateway.example.test/mcp",
      ready: true,
      checkedAt: now - 1000,
      validUntil: now,
    },
  },
  {
    ...evidence(),
    publicMcp: {
      url: "https://gateway.example.test/mcp",
      ready: true,
      checkedAt: now - 1000,
      validUntil: Infinity,
    },
  },
  {
    ...evidence(),
    publicMcp: {
      url: "https://gateway.example.test/mcp",
      ready: true,
      checkedAt: now - 1000,
      validUntil: now + 100_000,
    },
  },
  {
    ...evidence(),
    publicMcp: {
      url: "https://gateway.example.test/mcp",
      ready: true,
      checkedAt: now - 1000,
      validUntil: now - 2000,
    },
  },
  { ...evidence(), certificate: null },
])("linkage, missing, malformed or stale evidence never certifies route %#", (value) => {
  const account = desktopAccountSchema.parse(value);
  expect(account.account?.linked).toBe(true);
  expect(desktopRemoteRoute(account, now).state).toBe("unavailable");
});
test("actual checking state stays neutral, while certificate deadline caps success", () => {
  expect(desktopRemoteRoute({ ...evidence(), tunnel: { state: "connecting" } }, now).state).toBe(
    "checking",
  );
  expect(
    desktopRemoteRoute(
      {
        ...evidence(),
        certificate: { state: "expiring", expiresAt: new Date(now + 1000).toISOString() },
      },
      now,
    ).state,
  ).toBe("unavailable");
  expect(desktopRemoteRoute(evidence(), now + 89_000).state).toBe("unavailable");
});
