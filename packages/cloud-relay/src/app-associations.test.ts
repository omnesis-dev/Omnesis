// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { expect, test } from "vitest";
import { listen, closeServer } from "../test/support.js";
import { AppAssociations } from "./app-associations.js";
import { RelayError } from "./tunnels.js";

test("configured app identities and SHA-256 signing keys drive both platform associations and Android origin verification", async () => {
  const sha256 = Array(32).fill("AB").join(":"),
    apple = "EXAMPLE123.dev.example.reader";
  const service = new AppAssociations({
    apple: [apple],
    android: [{ packageName: "dev.example.reader", sha256: [sha256.toLowerCase(), sha256] }],
  });
  expect(service.androidOrigins()).toEqual([
    `android:apk-key-hash:${Buffer.alloc(32, 0xab).toString("base64url")}`,
  ]);
  const server = createServer((req, res) => {
    try {
      if (!service.handle(req, res)) {
        res.writeHead(404);
        res.end();
      }
    } catch (error) {
      res.writeHead(error instanceof RelayError ? error.status : 500);
      res.end();
    }
  });
  const url = await listen(server);
  try {
    const response = await fetch(url + "/.well-known/apple-app-site-association");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toEqual({ webcredentials: { apps: [apple] } });
    expect(await (await fetch(url + "/.well-known/assetlinks.json")).json()).toEqual([
      {
        relation: [
          "delegate_permission/common.handle_all_urls",
          "delegate_permission/common.get_login_creds",
        ],
        target: {
          namespace: "android_app",
          package_name: "dev.example.reader",
          sha256_cert_fingerprints: [sha256],
        },
      },
    ]);
    expect((await fetch(url + "/.well-known/assetlinks.json?unexpected=1")).status).toBe(400);
    expect((await fetch(url + "/.well-known/assetlinks.json", { method: "POST" })).status).toBe(
      405,
    );
    expect((await fetch(url + "/unrelated")).status).toBe(404);
  } finally {
    await closeServer(server);
  }
});

test("associations reject SHA-1, malformed identities, duplicate applications, unknown settings and unbounded lists", () => {
  const sha256 = Array(32).fill("AB").join(":"),
    apple = "EXAMPLE123.dev.example.reader";
  for (const input of [
    { apple: ["invalid"] },
    { apple: [apple, apple] },
    { apple: Array(17).fill(apple) },
    { android: [{ packageName: "invalid", sha256: [sha256] }] },
    { android: [{ packageName: "dev.example.reader", sha256: [Array(20).fill("AB").join(":")] }] },
    { android: [{ packageName: "dev.example.reader", sha256: [] }] },
    { android: [{ packageName: "dev.example.reader", sha256: [sha256], unknown: true }] },
    { android: Array(2).fill({ packageName: "dev.example.reader", sha256: [sha256] }) },
    { untrusted: true },
    null,
  ])
    expect(() => new AppAssociations(input)).toThrow();
  expect(new AppAssociations({}).androidOrigins()).toEqual([]);
});
