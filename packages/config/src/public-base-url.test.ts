// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import { omnesisConfigSchema } from "./config-schema.js";

describe("gateway.publicBaseUrl", () => {
  test.each([
    "https://gateway.example.org",
    "https://gateway.example.org:7600",
    "https://gateway.example.org/omnesis",
  ])("accepts the backwards-compatible HTTPS base URL %s", (publicBaseUrl) => {
    expect(omnesisConfigSchema.safeParse({ gateway: { publicBaseUrl } }).success).toBe(true);
  });

  test.each([
    "http://gateway.example.org",
    "https://gateway.example.org/",
    "https://user:secret@gateway.example.org",
    "https://gateway.example.org?redirect=elsewhere",
    "https://gateway.example.org?",
    "https://gateway.example.org#fragment",
    "https://gateway.example.org#",
    "https://gateway.example.org:99999",
    " https://gateway.example.org",
  ])("rejects the unsupported base URL %s", (publicBaseUrl) => {
    expect(omnesisConfigSchema.safeParse({ gateway: { publicBaseUrl } }).success).toBe(false);
  });
});

describe("gateway.pairingSystemTrustOrigins", () => {
  test("accepts exact HTTPS origins, including explicit ports", () => {
    expect(
      omnesisConfigSchema.safeParse({
        gateway: {
          pairingSystemTrustOrigins: [
            "https://gateway.example.org",
            "https://gateway.example.org:7600",
          ],
        },
      }).success,
    ).toBe(true);
  });

  test.each([
    "http://gateway.example.org:7600",
    "https://gateway.example.org/",
    "https://gateway.example.org/path",
    "https://user:secret@gateway.example.org",
    "https://gateway.example.org?mode=system",
  ])("rejects a non-origin or unsafe URL %s", (origin) => {
    expect(
      omnesisConfigSchema.safeParse({
        gateway: { pairingSystemTrustOrigins: [origin] },
      }).success,
    ).toBe(false);
  });
});

describe("gateway.mcpResourceUrls", () => {
  test("accepts exact HTTPS MCP resources on different hosts, ports, and paths", () => {
    expect(
      omnesisConfigSchema.safeParse({
        gateway: {
          publicBaseUrl: "https://gateway.example.org",
          mcpResourceUrls: [
            "https://private.example.net:7600/mcp",
            "https://proxy.example.org/omnesis/mcp",
          ],
        },
      }).success,
    ).toBe(true);
  });

  test.each([
    "https://private.example.net:7600/not-mcp",
    "http://private.example.net:7600/mcp",
    "https://private.example.net:7600/mcp?tenant=other",
    "https://user:secret@private.example.net:7600/mcp",
  ])("rejects an unsafe MCP resource URL %s", (resource) => {
    expect(
      omnesisConfigSchema.safeParse({ gateway: { mcpResourceUrls: [resource] } }).success,
    ).toBe(false);
  });

  test("allows an environment-supplied public base URL and requires distinct configured origins", () => {
    expect(
      omnesisConfigSchema.safeParse({
        gateway: { mcpResourceUrls: ["https://private.example.net/mcp"] },
      }).success,
    ).toBe(true);
    expect(
      omnesisConfigSchema.safeParse({
        gateway: {
          publicBaseUrl: "https://gateway.example.org",
          mcpResourceUrls: ["https://gateway.example.org/alternate/mcp"],
        },
      }).success,
    ).toBe(false);
  });
});
