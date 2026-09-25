// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FcmClient } from "./direct-fcm.js";

let dir: string;
let serviceAccountPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-fcm-test-"));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  serviceAccountPath = join(dir, "service-account.json");
  writeFileSync(
    serviceAccountPath,
    JSON.stringify({
      client_email: "push-sender@example.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      project_id: "example-project",
      token_uri: "https://oauth.example.com/token",
    }),
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("FcmClient", () => {
  test("uses OAuth HTTP v1 and sends only high-priority data", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("oauth.example.com")) {
        return new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }));
      }
      return new Response(JSON.stringify({ name: "projects/example/messages/1" }));
    });
    const client = new FcmClient({ config: { serviceAccountPath }, fetchFn, now: () => 1_000_000 });

    await expect(
      client.send({
        registrationToken: "registration-token",
      }),
    ).resolves.toEqual({ ok: true, name: "projects/example/messages/1" });

    expect(requests).toHaveLength(2);
    const send = requests[1]!;
    expect(send.url).toBe("https://fcm.googleapis.com/v1/projects/example-project/messages:send");
    expect((send.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer access-token",
    );
    expect(JSON.parse(String(send.init?.body))).toEqual({
      message: {
        token: "registration-token",
        data: { wake: "1" },
        android: { priority: "high" },
      },
    });
  });

  test("marks an FCM UNREGISTERED response for token cleanup", async () => {
    const fetchFn = vi.fn(async (input: string | URL) => {
      if (String(input).includes("oauth.example.com")) {
        return new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }));
      }
      return new Response(
        JSON.stringify({
          error: {
            status: "NOT_FOUND",
            details: [
              {
                "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                errorCode: "UNREGISTERED",
              },
            ],
          },
        }),
        { status: 404 },
      );
    });
    const client = new FcmClient({ config: { serviceAccountPath }, fetchFn });
    const result = await client.send({ registrationToken: "stale-token" });
    expect(result).toMatchObject({ ok: false, reason: "UNREGISTERED", unregistered: true });
  });

  test("caches the OAuth access token across sends", async () => {
    const fetchFn = vi.fn(async (input: string | URL) =>
      String(input).includes("oauth.example.com")
        ? new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }))
        : new Response(JSON.stringify({ name: "message" })),
    );
    const client = new FcmClient({ config: { serviceAccountPath }, fetchFn, now: () => 1_000_000 });
    await client.send({ registrationToken: "one" });
    await client.send({ registrationToken: "two" });
    expect(
      fetchFn.mock.calls.filter(([input]) => String(input).includes("oauth.example.com")),
    ).toHaveLength(1);
  });

  test("singleflights concurrent OAuth refreshes", async () => {
    const fetchFn = vi.fn(async (input: string | URL) =>
      String(input).includes("oauth.example.com")
        ? new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }))
        : new Response(JSON.stringify({ name: "message" })),
    );
    const client = new FcmClient({ config: { serviceAccountPath }, fetchFn, now: () => 1_000_000 });

    await Promise.all([
      client.send({ registrationToken: "one" }),
      client.send({ registrationToken: "two" }),
    ]);

    expect(
      fetchFn.mock.calls.filter(([input]) => String(input).includes("oauth.example.com")),
    ).toHaveLength(1);
  });

  test("rejects oversized provider responses", async () => {
    const fetchFn = vi.fn(async (input: string | URL) =>
      String(input).includes("oauth.example.com")
        ? new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }))
        : new Response("x".repeat(70_000)),
    );
    const client = new FcmClient({ config: { serviceAccountPath }, fetchFn });

    await expect(client.send({ registrationToken: "one" })).rejects.toThrow("maximum size");
  });
});
