// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { oauthCallbackHost } from "./oauth-callback-host.js";

afterEach(() => vi.unstubAllEnvs());

describe("OAuth callback listener binding", () => {
  it("keeps native installs on loopback by default", () => {
    vi.stubEnv("OMNESIS_OAUTH_CALLBACK_HOST", undefined);
    expect(oauthCallbackHost()).toBe("localhost");
  });

  it("requires an explicit supported container bind address", () => {
    vi.stubEnv("OMNESIS_OAUTH_CALLBACK_HOST", "0.0.0.0");
    expect(oauthCallbackHost()).toBe("0.0.0.0");
    vi.stubEnv("OMNESIS_OAUTH_CALLBACK_HOST", "example.com");
    expect(() => oauthCallbackHost()).toThrow("must be localhost, 127.0.0.1, or 0.0.0.0");
  });

  it("accepts callbacks forwarded to a non-loopback container interface", async () => {
    const address = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
    // A loopback-only test environment cannot simulate Docker forwarding.
    if (!address) return;
    vi.stubEnv("OMNESIS_OAUTH_CALLBACK_HOST", "0.0.0.0");
    const server = createServer((_req, res) => res.end("callback reached"));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, oauthCallbackHost(), resolve);
      });
      const bound = server.address();
      if (!bound || typeof bound === "string") throw new Error("Missing callback listener");
      const response = await fetch(`http://${address}:${bound.port}/oauth2callback`);
      expect(await response.text()).toBe("callback reached");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
