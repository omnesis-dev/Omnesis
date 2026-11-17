// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import { PublicAddress, fixedPublicAddress } from "./public-address.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("PublicAddress", () => {
  test("takes a saved address at once, with the MCP resource it implies", () => {
    vi.stubEnv("OMNESIS_PUBLIC_BASE_URL", "");
    const address = new PublicAddress(undefined);
    expect(address.baseUrl()).toBeUndefined();
    expect(address.mcpResourceUrls()).toEqual([]);

    address.update({ gateway: { publicBaseUrl: "https://omnesis.example.org" } });
    expect(address.baseUrl()).toBe("https://omnesis.example.org");
    expect(address.mcpResourceUrls()).toEqual(["https://omnesis.example.org/mcp"]);
    expect(address.setByEnvironment()).toBe(false);

    address.update({
      gateway: {
        publicBaseUrl: "https://gateway.example.net",
        mcpResourceUrls: ["https://private.example.org:7600/mcp"],
      },
    });
    expect(address.baseUrl()).toBe("https://gateway.example.net");
    expect(address.mcpResourceUrls()).toEqual([
      "https://gateway.example.net/mcp",
      "https://private.example.org:7600/mcp",
    ]);

    address.update({ gateway: {} });
    expect(address.baseUrl()).toBeUndefined();
    expect(address.mcpResourceUrls()).toEqual([]);
  });

  test("the environment's address wins over a saved one", () => {
    vi.stubEnv("OMNESIS_PUBLIC_BASE_URL", "https://env.example.org");
    const address = new PublicAddress({
      gateway: { publicBaseUrl: "https://omnesis.example.org" },
    });
    expect(address.baseUrl()).toBe("https://env.example.org");
    expect(address.setByEnvironment()).toBe(true);

    address.update({ gateway: { publicBaseUrl: "https://gateway.example.net" } });
    expect(address.baseUrl()).toBe("https://env.example.org");
    expect(address.setByEnvironment()).toBe(true);
  });

  test("an address the MCP resources cannot be served with keeps the one in use", () => {
    vi.stubEnv("OMNESIS_PUBLIC_BASE_URL", "");
    const address = new PublicAddress({
      gateway: { publicBaseUrl: "https://omnesis.example.org" },
    });
    address.update({ gateway: { mcpResourceUrls: ["https://private.example.org:7600/mcp"] } });
    expect(address.baseUrl()).toBe("https://omnesis.example.org");
    expect(address.mcpResourceUrls()).toEqual(["https://omnesis.example.org/mcp"]);
  });

  test("refuses at start an MCP resource with no public address to serve it", () => {
    vi.stubEnv("OMNESIS_PUBLIC_BASE_URL", "");
    expect(
      () =>
        new PublicAddress({
          gateway: { mcpResourceUrls: ["https://private.example.org:7600/mcp"] },
        }),
    ).toThrow(/requires gateway.publicBaseUrl/);
  });
});

test("a fixed address never changes and is never the environment's", () => {
  const address = fixedPublicAddress("https://omnesis.example.org", [
    "https://omnesis.example.org/mcp",
  ]);
  expect(address.baseUrl()).toBe("https://omnesis.example.org");
  expect(address.mcpResourceUrls()).toEqual(["https://omnesis.example.org/mcp"]);
  expect(address.setByEnvironment()).toBe(false);
});
