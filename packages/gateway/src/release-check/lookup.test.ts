// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { dockerReleaseRepositories, listOciStableTags, lookupLatestRelease } from "./lookup.js";

const SIGNAL = new AbortController().signal;

describe("install-method release lookups", () => {
  test("source asks its origin for stable refs and reduces them with strict tag ordering", async () => {
    const runGit = vi.fn(() =>
      Promise.resolve(
        ["a refs/tags/v1.8.0", "b refs/tags/v2.0.0-beta.1", "c refs/tags/v1.10.0"].join("\n"),
      ),
    );
    await expect(
      lookupLatestRelease({ method: "source", rootDir: "/repo" }, { runGit }, SIGNAL),
    ).resolves.toBe("1.10.0");
    expect(runGit).toHaveBeenCalledWith("/repo", SIGNAL);
  });

  test("a package install reads the configured package index's /latest document", async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ version: "3.2.1" })));
    await expect(
      lookupLatestRelease(
        { method: "npm-global" },
        {
          fetchFn,
          env: { OMNESIS_PACKAGE_INDEX_URL: "https://packages.example.org/omnesis/" },
        },
        SIGNAL,
      ),
    ).resolves.toBe("3.2.1");
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://packages.example.org/omnesis/latest");
  });

  test("a container install intersects stable tags across its actual image repositories", async () => {
    const compose = `
services:
  gateway:
    image: "registry.example.org/team/omnesis-gateway:\${OMNESIS_IMAGE_TAG}"
  collector:
    image: "registry.example.org/team/omnesis-collector:\${OMNESIS_IMAGE_TAG}"
  updater:
    image: "registry.example.org/team/omnesis-updater:\${OMNESIS_IMAGE_TAG}"
`;
    const fetchFn = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      const tags = url.includes("omnesis-collector")
        ? ["1.0.0", "1.2.0"]
        : url.includes("omnesis-updater")
          ? ["1.2.0", "2.0.0"]
          : ["1.0.0", "1.2.0", "2.0.0", "main"];
      return Promise.resolve(Response.json({ tags }));
    });
    await expect(
      lookupLatestRelease(
        { method: "docker", composeFile: "/state/docker-compose.yml", projectDir: "/state" },
        { readCompose: () => Promise.resolve(compose), fetchFn },
        SIGNAL,
      ),
    ).resolves.toBe("1.2.0");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  test("a Docker lookup says nothing when the update service is absent", () => {
    expect(
      dockerReleaseRepositories(
        `services:\n  gateway:\n    image: ghcr.io/acme/omnesis-gateway:1.0.0`,
      ),
    ).toEqual([]);
  });
});

describe("OCI tag listing boundaries", () => {
  test("uses an anonymous Bearer token and follows only the same tags endpoint", async () => {
    const calls: string[] = [];
    const fetchFn = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://registry.example.org/token")) {
        expect(url).toContain("scope=repository%3Ateam%2Fomnesis-gateway%3Apull");
        return Promise.resolve(Response.json({ token: "token-value" }));
      }
      if (url.includes("last=1.0.0")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-value");
        return Promise.resolve(Response.json({ tags: ["1.1.0"] }));
      }
      if (new Headers(init?.headers).get("authorization")) {
        return Promise.resolve(
          new Response(JSON.stringify({ tags: ["1.0.0"] }), {
            headers: {
              "content-type": "application/json",
              link: '</v2/team/omnesis-gateway/tags/list?n=1000&last=1.0.0>; rel="next"',
            },
          }),
        );
      }
      return Promise.resolve(
        new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://registry.example.org/token",service="registry.example.org", Basic realm="ignored"',
          },
        }),
      );
    });

    await expect(
      listOciStableTags("registry.example.org/team/omnesis-gateway", fetchFn, SIGNAL),
    ).resolves.toEqual(new Set(["1.0.0", "1.1.0"]));
    expect(calls).toContain(
      "https://registry.example.org/v2/team/omnesis-gateway/tags/list?n=1000&last=1.0.0",
    );
  });

  test("refuses an off-origin pagination link", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ tags: ["1.0.0"] }), {
          headers: {
            "content-type": "application/json",
            link: '<https://other.example.org/v2/team/omnesis-gateway/tags/list?n=1000>; rel="next"',
          },
        }),
      ),
    );
    await expect(
      listOciStableTags("registry.example.org/team/omnesis-gateway", fetchFn, SIGNAL),
    ).rejects.toThrow(/left the tags endpoint/u);
  });

  test("refuses an insecure Bearer-token realm", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer realm="http://auth.example.org/token"',
          },
        }),
      ),
    );
    await expect(
      listOciStableTags("registry.example.org/team/omnesis-gateway", fetchFn, SIGNAL),
    ).rejects.toThrow(/unsafe Bearer realm/u);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  test("refuses a Bearer-token realm on an unrelated HTTPS origin", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer realm="https://auth.example.net/token"',
          },
        }),
      ),
    );
    await expect(
      listOciStableTags("registry.example.org/team/omnesis-gateway", fetchFn, SIGNAL),
    ).rejects.toThrow(/unsafe Bearer realm/u);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  test("allows the default registry's well-known cross-origin token service", async () => {
    const fetchFn = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://auth.docker.io/token")) {
        return Promise.resolve(Response.json({ token: "docker-token" }));
      }
      if (new Headers(init?.headers).get("authorization")) {
        return Promise.resolve(Response.json({ tags: ["1.2.3"] }));
      }
      return Promise.resolve(
        new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer realm="https://auth.docker.io/token"',
          },
        }),
      );
    });
    await expect(listOciStableTags("omnesis-gateway", fetchFn, SIGNAL)).resolves.toEqual(
      new Set(["1.2.3"]),
    );
  });

  test("bounds remote response bodies before parsing them", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response("x".repeat(1024 * 1024 + 1), {
          headers: { "content-length": String(1024 * 1024 + 1) },
        }),
      ),
    );
    await expect(
      listOciStableTags("registry.example.org/team/omnesis-gateway", fetchFn, SIGNAL),
    ).rejects.toThrow(/size limit/u);
  });
});
