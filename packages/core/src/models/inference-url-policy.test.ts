// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import {
  InferenceUrlPolicyError,
  assertInferenceUrlAllowed,
  classifyInferenceIp,
  fetchWithInferenceUrlPolicy,
} from "./inference-url-policy.js";

const loopbackLookup = async () => [{ address: "127.0.0.1", family: 4 as const }];
const publicLookup = async () => [{ address: "203.0.113.10", family: 4 as const }];
const privateLookup = async () => [{ address: "198.18.0.1", family: 4 as const }];
const metadataLookup = async () => [{ address: "169.254.169.254", family: 4 as const }];

describe("inference URL policy", () => {
  test("classifies loopback, private, public, and blocked addresses", () => {
    expect(classifyInferenceIp("127.0.0.1")).toBe("loopback");
    expect(classifyInferenceIp("::1")).toBe("loopback");
    expect(classifyInferenceIp("198.18.0.1")).toBe("private");
    expect(classifyInferenceIp("8.8.8.8")).toBe("public");
    expect(classifyInferenceIp("169.254.169.254")).toBe("blocked");
    expect(classifyInferenceIp("::")).toBe("blocked");
    expect(classifyInferenceIp("fe80::1")).toBe("blocked");
  });

  test("allows loopback HTTP inference by default", async () => {
    await expect(
      assertInferenceUrlAllowed("http://localhost:8001/v1/models", { lookup: loopbackLookup }),
    ).resolves.toBeInstanceOf(URL);
  });

  test("rejects public and private hosts by default", async () => {
    await expect(
      assertInferenceUrlAllowed("https://api.example.com/v1/models", { lookup: publicLookup }),
    ).rejects.toThrow(/allowRemoteInference=true/);
    await expect(
      assertInferenceUrlAllowed("http://gpu.lan:8001/v1/models", { lookup: privateLookup }),
    ).rejects.toThrow(/allowRemoteInference=true/);
  });

  test("allows public and private hosts only with explicit remote opt-in", async () => {
    await expect(
      assertInferenceUrlAllowed("https://api.example.com/v1/models", {
        allowRemoteInference: true,
        lookup: publicLookup,
      }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertInferenceUrlAllowed("http://gpu.lan:8001/v1/models", {
        allowRemoteInference: true,
        lookup: privateLookup,
      }),
    ).resolves.toBeInstanceOf(URL);
  });

  test("keeps metadata and link-local addresses blocked even with remote opt-in", async () => {
    await expect(
      assertInferenceUrlAllowed("http://metadata.local/v1/models", {
        allowRemoteInference: true,
        lookup: metadataLookup,
      }),
    ).rejects.toThrow(InferenceUrlPolicyError);
  });

  test("rejects hostnames that resolve to no addresses", async () => {
    await expect(
      assertInferenceUrlAllowed("https://empty.example.com/v1/models", {
        allowRemoteInference: true,
        lookup: async () => [],
      }),
    ).rejects.toThrow(/no addresses/);
  });

  test("rejects embedded credentials and non-http schemes", async () => {
    await expect(
      assertInferenceUrlAllowed("https://user:pass@example.com/v1/models", {
        allowRemoteInference: true,
        lookup: publicLookup,
      }),
    ).rejects.toThrow(/embedded credentials/);
    await expect(assertInferenceUrlAllowed("file:///etc/passwd")).rejects.toThrow(
      /disallowed scheme/,
    );
  });

  test("fetch wrapper validates same-origin redirects and blocks cross-origin redirects", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 307, headers: { location: "/v1/models" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const res = await fetchWithInferenceUrlPolicy(
      "http://localhost:8001/redirect",
      { method: "GET" },
      { fetchFn: fetchFn as unknown as typeof fetch, lookup: loopbackLookup },
    );
    expect(res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const crossOriginFetch = vi.fn().mockResolvedValue(
      new Response("", {
        status: 307,
        headers: { location: "https://api.example.com/v1/models" },
      }),
    );
    await expect(
      fetchWithInferenceUrlPolicy(
        "http://localhost:8001/redirect",
        {},
        {
          allowRemoteInference: true,
          fetchFn: crossOriginFetch as unknown as typeof fetch,
          lookup: loopbackLookup,
        },
      ),
    ).rejects.toThrow(/cross-origin redirect/);
  });
});
