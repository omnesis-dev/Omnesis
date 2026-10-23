// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { dockerReleaseImages, newestCommonDockerTag } from "./docker-registry.js";

function json(body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { headers });
}

function fetcher(handler: (url: URL, init?: RequestInit) => Response) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(new URL(String(input)), init),
  ) as unknown as typeof fetch;
}

describe("newestCommonDockerTag", () => {
  test("requires a stable release in every Compose image, including combined and updater", async () => {
    const request = fetcher((url) =>
      json({
        tags: url.pathname.includes("updater")
          ? ["1.9.0", "1.10.0", "2.0.0-beta.1"]
          : ["1.9.0", "1.10.0", "2.0.0", "latest"],
      }),
    );
    await expect(
      newestCommonDockerTag(
        ["ghcr.io/example/omnesis-combined:1.9.0", "ghcr.io/example/omnesis-updater:1.9.0"],
        request,
      ),
    ).resolves.toBe("1.10.0");
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("handles an anonymous bearer challenge, pagination and access_token", async () => {
    const request = fetcher((url, init) => {
      if (url.pathname === "/token") {
        expect(url.searchParams.get("scope")).toBe("repository:example/gateway:pull");
        expect(url.searchParams.get("service")).toBe("registry.example.com");
        return json({ access_token: "throwaway-token" });
      }
      if (!(init?.headers as Record<string, string> | undefined)?.Authorization) {
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://auth.example.com/token",service="registry.example.com"',
          },
        });
      }
      expect(init?.headers).toEqual({ Authorization: "Bearer throwaway-token" });
      if (url.searchParams.has("last")) return json({ tags: ["3.0.0"] });
      return json(
        { tags: ["2.0.0"] },
        { link: '</v2/example/gateway/tags/list?n=1000&last=2.0.0>; rel="next"' },
      );
    });
    await expect(
      newestCommonDockerTag(["registry.example.com/example/gateway:2.0.0"], request),
    ).resolves.toBe("3.0.0");
    expect(request).toHaveBeenCalledTimes(4);
  });

  test.each([null, {}, { token: 42 }, { token: "unsafe\nheader" }])(
    "rejects unusable anonymous token responses %j",
    async (body) => {
      const request = fetcher((url) => {
        if (url.pathname === "/token") return json(body);
        return new Response("", {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="https://auth.example.com/token"' },
        });
      });
      await expect(
        newestCommonDockerTag(["ghcr.io/example/gateway:1.0.0"], request),
      ).rejects.toThrow("no usable anonymous token");
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  test("normalizes the default public registry and allows only loopback development HTTP", async () => {
    const urls: string[] = [];
    const request = fetcher((url) => {
      urls.push(url.href);
      return json({ tags: ["1.0.0"] });
    });
    await newestCommonDockerTag(
      ["redis:1.0.0", "docker.io/library/redis:1.0.0", "localhost:5000/example/gateway:1.0.0"],
      request,
    );
    expect(urls).toEqual([
      "https://registry-1.docker.io/v2/library/redis/tags/list?n=1000",
      "http://localhost:5000/v2/example/gateway/tags/list?n=1000",
    ]);
  });

  test.each([401, 403])("private registry HTTP %s gives pinned-version remedy", async (status) => {
    await expect(
      newestCommonDockerTag(
        ["registry.example.com/example/gateway:1.0.0"],
        fetcher(() => new Response("", { status })),
      ),
    ).rejects.toThrow(/docker login.*--version.*--target-version/);
  });

  test("rejects cross-origin pagination before forwarding a token", async () => {
    const request = fetcher(() =>
      json(
        { tags: ["1.0.0"] },
        { link: '<https://other.example.com/v2/example/gateway/tags/list>; rel="next"' },
      ),
    );
    await expect(newestCommonDockerTag(["ghcr.io/example/gateway:1.0.0"], request)).rejects.toThrow(
      "left its repository",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("rejects cyclic pagination", async () => {
    await expect(
      newestCommonDockerTag(
        ["ghcr.io/example/gateway:1.0.0"],
        fetcher(() =>
          json({ tags: [] }, { link: '</v2/example/gateway/tags/list?n=1000>; rel="next"' }),
        ),
      ),
    ).rejects.toThrow("discovery limit");
  });

  test("rejects insecure remote authentication realms", async () => {
    const request = fetcher(
      () =>
        new Response("", {
          status: 401,
          headers: { "www-authenticate": 'Bearer realm="http://auth.example.com/token"' },
        }),
    );
    await expect(newestCommonDockerTag(["ghcr.io/example/gateway:1.0.0"], request)).rejects.toThrow(
      "secure realm",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  test.each([null, { tags: [1] }, { name: "another/repository", tags: [] }])(
    "rejects invalid registry data %j",
    async (body) => {
      await expect(
        newestCommonDockerTag(
          ["ghcr.io/example/gateway:1.0.0"],
          fetcher(() => json(body)),
        ),
      ).rejects.toThrow("invalid tag list");
    },
  );

  test("rejects oversized response bodies", async () => {
    await expect(
      newestCommonDockerTag(
        ["ghcr.io/example/gateway:1.0.0"],
        fetcher(() => new Response("x".repeat(1_048_577))),
      ),
    ).rejects.toThrow("discovery limit");
  });

  test("does not select a release missing from any image", async () => {
    const request = fetcher((url) =>
      json({ tags: url.pathname.includes("updater") ? ["2.0.0"] : ["1.0.0"] }),
    );
    await expect(
      newestCommonDockerTag(
        ["ghcr.io/example/gateway:1.0.0", "ghcr.io/example/updater:1.0.0"],
        request,
      ),
    ).rejects.toThrow("No stable X.Y.Z tag");
  });

  test("refuses empty projects and digest-pinned images", async () => {
    const request = fetcher(() => json({ tags: [] }));
    await expect(newestCommonDockerTag([], request)).rejects.toThrow("image set");
    await expect(
      newestCommonDockerTag(["ghcr.io/example/gateway@sha256:abc"], request),
    ).rejects.toThrow("Digest-pinned");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("dockerReleaseImages", () => {
  test("keeps combined and updater release images while excluding an independently versioned sidecar", () => {
    const raw = {
      services: {
        gateway: { image: "ghcr.io/example/omnesis-combined:${OMNESIS_IMAGE_TAG}" },
        updater: { image: "ghcr.io/example/omnesis-updater:$OMNESIS_IMAGE_TAG" },
        tailscale: { image: "tailscale/tailscale:latest" },
      },
    };
    const rendered = {
      services: {
        gateway: { image: "ghcr.io/example/omnesis-combined:1.0.0" },
        updater: { image: "ghcr.io/example/omnesis-updater:1.0.0" },
        tailscale: { image: "tailscale/tailscale:latest" },
      },
    };
    expect(dockerReleaseImages(JSON.stringify(raw), JSON.stringify(rendered))).toEqual([
      "ghcr.io/example/omnesis-combined:1.0.0",
      "ghcr.io/example/omnesis-updater:1.0.0",
    ]);
  });

  test("refuses static images and variables that merely share the release variable prefix", () => {
    const config = JSON.stringify({
      services: { gateway: { image: "example/gateway:$OMNESIS_IMAGE_TAG_OTHER" } },
    });
    expect(() => dockerReleaseImages(config, config)).toThrow("no images referencing");
  });

  test("refuses an unresolved release image", () => {
    expect(() =>
      dockerReleaseImages(
        JSON.stringify({
          services: { gateway: { image: "example/gateway:${OMNESIS_IMAGE_TAG:-latest}" } },
        }),
        JSON.stringify({ services: {} }),
      ),
    ).toThrow("did not resolve");
  });
});
