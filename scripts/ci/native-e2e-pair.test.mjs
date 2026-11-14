// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairNativeOwner, writeNativeConfig } from "./native-e2e-pair.mjs";

describe("isolated native owner pairing", () => {
  it("redeems a real phone code and uses the paired credential, not the bootstrap", async () => {
    const calls = [];
    const config = await pairNativeOwner({
      gatewayURL: "https://localhost:17601",
      bootstrapToken: "fictional-bootstrap",
      kind: "ios",
      post: async (base, path, body, token) => {
        calls.push({ base: base.origin, path, body, token });
        return path === "/admin/devices/pair"
          ? { pairingCode: "fixture-code" }
          : {
              token: "fictional-paired-owner",
              device: { id: "fixture-device", kind: "ios" },
              scopes: ["admin", "read"],
            };
      },
    });
    expect(calls).toEqual([
      {
        base: "https://localhost:17601",
        path: "/admin/devices/pair",
        body: { kind: "ios", name: "Native scope test phone" },
        token: "fictional-bootstrap",
      },
      {
        base: "https://localhost:17601",
        path: "/devices/pair",
        body: { pairingCode: "fixture-code" },
        token: undefined,
      },
    ]);
    expect(config.apiToken).toBe("fictional-paired-owner");
    expect(config.deviceId).toBe("fixture-device");
  });
  it.each(["https://gateway.example:17601", "https://localhost:7600", "http://localhost:17601"])(
    "refuses non-isolated targets: %s",
    async (gatewayURL) => {
      let called = false;
      await expect(
        pairNativeOwner({
          gatewayURL,
          bootstrapToken: "fixture",
          kind: "android",
          post: async () => {
            called = true;
            return {};
          },
        }),
      ).rejects.toThrow("isolated");
      expect(called).toBe(false);
    },
  );
  it("rejects a collector credential even if it carries admin", async () => {
    await expect(
      pairNativeOwner({
        gatewayURL: "https://localhost:17700",
        bootstrapToken: "fixture",
        kind: "android",
        post: async (_base, path) =>
          path === "/admin/devices/pair"
            ? { pairingCode: "fixture-code" }
            : {
                token: "fixture-token",
                device: { id: "fixture-device", kind: "collector" },
                scopes: ["admin"],
              },
      }),
    ).rejects.toThrow("owner phone");
  });
  it("writes the ephemeral credential owner-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "native-pair-fixture-"));
    try {
      const path = join(dir, "config.json");
      writeNativeConfig(path, { apiToken: "fictional-paired-owner" });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8")).apiToken).toBe("fictional-paired-owner");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
