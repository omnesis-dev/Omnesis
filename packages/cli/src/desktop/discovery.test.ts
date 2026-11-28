// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { discoverDesktopHomes } from "./discovery.js";
import type { authorizeAccountDesktop, listAccountGateways } from "@omnesis/cloud-relay";

function fixture() {
  const controller = new AbortController();
  const ui = { openBrowser: vi.fn(async () => {}), connectCode: vi.fn() };
  const options = {
    relayUrl: "https://relay.example.test",
    name: "fictional-mac",
    signal: controller.signal,
    ui,
  };
  const authorization = {
    status: "approved" as const,
    discoveryToken: "fictional-discovery",
    accountId: "a".repeat(64),
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  };
  const authorize = vi.fn<typeof authorizeAccountDesktop>().mockResolvedValue(authorization);
  const list = vi.fn<typeof listAccountGateways>().mockResolvedValue([]);
  return { controller, options, authorization, authorize, list };
}

test("only a successful empty account directory permits setting up the first home", async () => {
  const f = fixture();
  expect(await discoverDesktopHomes(f.options, f)).toEqual({ kind: "no-home" });
  expect(f.authorize.mock.calls[0]![0]).toMatchObject({ kind: "cli", name: "fictional-mac" });
  expect(f.authorize.mock.calls[0]![0].nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(f.list.mock.calls[0]![0].token).toBe(f.authorization.discoveryToken);
});

test("an offline existing home remains a home rather than starting another index", async () => {
  const f = fixture();
  const homes = [
    {
      gatewayId: "00000000-0000-4000-8000-000000000001",
      publicOrigin: "https://library.example.test",
      online: false,
    },
  ];
  f.list.mockResolvedValue(homes);
  expect(await discoverDesktopHomes(f.options, f)).toEqual({ kind: "homes", homes });
});

test("failed sign-in or directory outage never looks like an empty account", async () => {
  const f = fixture();
  f.authorize.mockRejectedValueOnce(new Error("Sign-in unavailable"));
  await expect(discoverDesktopHomes(f.options, f)).rejects.toThrow("Sign-in unavailable");
  expect(f.list).not.toHaveBeenCalled();
  f.list.mockRejectedValue(new Error("Directory unavailable"));
  await expect(discoverDesktopHomes(f.options, f)).rejects.toThrow("Directory unavailable");
});

test("expired or cancelled discovery cannot offer first-home setup", async () => {
  const f = fixture();
  f.authorization.expiresAt = Math.floor(Date.now() / 1000) - 1;
  await expect(discoverDesktopHomes(f.options, f)).rejects.toThrow("expired");
  expect(f.list).not.toHaveBeenCalled();
  f.authorization.expiresAt += 300;
  f.list.mockImplementation(async () => {
    f.controller.abort();
    return [];
  });
  await expect(discoverDesktopHomes(f.options, f)).rejects.toThrow();
});

test("rejects non-origin destinations before opening sign-in", async () => {
  for (const relayUrl of [
    "http://relay.example.test",
    "https://user@relay.example.test",
    "https://relay.example.test/path",
    "https://relay.example.test/?credential=secret",
    "https://relay.example.test/#fragment",
  ]) {
    const f = fixture();
    await expect(discoverDesktopHomes({ ...f.options, relayUrl }, f)).rejects.toThrow();
    expect(f.authorize).not.toHaveBeenCalled();
  }
});
