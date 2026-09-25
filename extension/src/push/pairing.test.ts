// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { defaultScopesForDeviceKind } from "@omnesis/types";
import {
  GatewayUrlError,
  PairingOutcomeUnknownError,
  minimumGatewayVersionFor,
  REQUIRED_WEB_SCOPE,
  isIpLiteral,
  normalizeGatewayUrl,
  pair,
  readGatewayVersion,
} from "./pairing.js";
import { MAX_GATEWAY_REASON_CHARS } from "./response-body.js";
import { FakeFetch, jsonResponse, type RecordedRequest } from "./test-fakes.js";
import type { FetchLike } from "./types.js";

/** The redemption requests only — `pair()` asks the health check first. */
function pairRequests(fetch: FakeFetch): RecordedRequest[] {
  return fetch.requests.filter((request) => request.url.endsWith("/devices/pair"));
}

describe("normalizeGatewayUrl", () => {
  it("accepts a trusted https hostname and returns the origin", () => {
    expect(normalizeGatewayUrl("https://gateway.example.ts.net:7600")).toBe(
      "https://gateway.example.ts.net:7600",
    );
  });

  it("strips path/query/fragment", () => {
    expect(normalizeGatewayUrl("https://gateway.example.ts.net/portal?x=1#y")).toBe(
      "https://gateway.example.ts.net",
    );
  });

  it("rejects an IPv4 literal with a hostname-requirement message", () => {
    expect(() => normalizeGatewayUrl("https://203.0.113.7:7600")).toThrow(GatewayUrlError);
    try {
      normalizeGatewayUrl("https://203.0.113.7:7600");
    } catch (err) {
      expect((err as Error).message).toMatch(/hostname/i);
      expect((err as Error).message).toMatch(/certificate/i);
    }
  });

  it("rejects a bracketed IPv6 literal", () => {
    expect(() => normalizeGatewayUrl("https://[2001:db8::1]:7600")).toThrow(GatewayUrlError);
  });

  it("rejects http (TLS only)", () => {
    expect(() => normalizeGatewayUrl("http://gateway.example.ts.net")).toThrow(/https/i);
  });

  it("rejects URL userinfo", () => {
    expect(() => normalizeGatewayUrl("https://user:password@gateway.example.com:7600")).toThrow(
      /username or password/i,
    );
  });

  it("rejects an empty / unparseable URL", () => {
    expect(() => normalizeGatewayUrl("")).toThrow(GatewayUrlError);
    expect(() => normalizeGatewayUrl("not a url")).toThrow(GatewayUrlError);
  });
});

describe("isIpLiteral", () => {
  it("flags IPv4 and IPv6, passes hostnames", () => {
    expect(isIpLiteral("203.0.113.7")).toBe(true);
    expect(isIpLiteral("2001:db8::1")).toBe(true);
    expect(isIpLiteral("gateway.example.ts.net")).toBe(false);
    expect(isIpLiteral("localhost")).toBe(false);
  });
});

describe("pair", () => {
  it("posts the pairing code + capabilities and returns token/scopes", async () => {
    const fetch = new FakeFetch(() =>
      jsonResponse(200, {
        device: { id: "dev_1", name: "Browser extension", kind: "browser" },
        token: "tok_write_web",
        scopes: ["write:web"],
      }),
    );
    const result = await pair(
      "https://gateway.example.ts.net:7600",
      "0123456789",
      fetch.fetch,
      "Browser extension test",
    );
    expect(result.token).toBe("tok_write_web");
    expect(result.scopes).toEqual(["write:web"]);

    const req = pairRequests(fetch)[0];
    expect(req.url).toBe("https://gateway.example.ts.net:7600/devices/pair");
    expect((req.body as { pairingCode: string }).pairingCode).toBe("0123456789");
    expect(req.redirect).toBe("error");
    expect((req.body as { capabilities: { platform: string } }).capabilities.platform).toBe("web");
  });

  it("declares this build's version, and omits it rather than guessing when it has none", async () => {
    // The extension never opens a device socket, so pair time is the only
    // moment the gateway's version ledger can learn what build this is.
    const makeFetch = () =>
      new FakeFetch(() =>
        jsonResponse(200, {
          device: { id: "dev_1", name: "Browser extension", kind: "browser" },
          token: "tok_write_web",
          scopes: ["write:web"],
        }),
      );

    const withVersion = makeFetch();
    await pair("https://gateway.example.ts.net:7600", "0123456789", withVersion.fetch, "Test", {
      version: "9.8.7",
    });
    expect(
      (pairRequests(withVersion)[0].body as { capabilities: { version?: string } }).capabilities
        .version,
    ).toBe("9.8.7");

    const withoutVersion = makeFetch();
    await pair("https://gateway.example.ts.net:7600", "0123456789", withoutVersion.fetch, "Test");
    expect(
      (pairRequests(withoutVersion)[0].body as { capabilities: { version?: string } }).capabilities,
    ).not.toHaveProperty("version");
  });

  it("sends the caller's stable device name as capabilities.suggestedName", async () => {
    // Each install passes its own unique name so two machines don't collapse
    // onto one shared "browser" device row and evict each other's token.
    const fetch = new FakeFetch(() =>
      jsonResponse(200, {
        device: { id: "dev_1", name: "Browser extension a1b2c3d4", kind: "browser" },
        token: "tok_write_web",
        scopes: ["write:web"],
      }),
    );
    await pair(
      "https://gateway.example.ts.net:7600",
      "0123456789",
      fetch.fetch,
      "Browser extension a1b2c3d4",
    );
    const caps = (pairRequests(fetch)[0].body as { capabilities: { suggestedName: string } })
      .capabilities;
    expect(caps.suggestedName).toBe("Browser extension a1b2c3d4");
  });

  it("rejects an IP-literal gateway before making any network call", async () => {
    const fetch = new FakeFetch(() => jsonResponse(200, {}));
    await expect(
      pair("https://203.0.113.7:7600", "0123456789", fetch.fetch, "Browser extension test"),
    ).rejects.toThrow(GatewayUrlError);
    expect(fetch.requests).toHaveLength(0);
  });

  it("surfaces the gateway error body on a non-2xx", async () => {
    const fetch = new FakeFetch(() =>
      jsonResponse(400, { error: "invalid or expired pairing code" }),
    );
    await expect(
      pair("https://gateway.example.ts.net", "deadbeef00", fetch.fetch, "Browser extension test"),
    ).rejects.toThrow(/invalid or expired/i);
  });

  it("requires a non-empty pairing code", async () => {
    const fetch = new FakeFetch(() => jsonResponse(200, {}));
    await expect(
      pair("https://gateway.example.ts.net", "  ", fetch.fetch, "Browser extension test"),
    ).rejects.toThrow(GatewayUrlError);
    expect(fetch.requests).toHaveLength(0);
  });

  it("rejects a browser token minted without write:web", async () => {
    const fetch = new FakeFetch(() =>
      jsonResponse(200, {
        device: { id: "dev_2", name: "Browser extension", kind: "browser" },
        token: "tok_apple_health",
        scopes: ["admin", "read", "write:apple-health"],
      }),
    );
    await expect(
      pair(
        "https://gateway.example.ts.net:7600",
        "0123456789",
        fetch.fetch,
        "Browser extension test",
      ),
    ).rejects.toThrow(/write:web/i);
  });

  it("rejects an over-privileged wildcard token", async () => {
    const fetch = new FakeFetch(() =>
      jsonResponse(200, {
        device: { id: "dev_3", name: "Browser extension", kind: "browser" },
        token: "tok_admin",
        scopes: ["read", "write:*"],
      }),
    );
    await expect(
      pair(
        "https://gateway.example.ts.net:7600",
        "0123456789",
        fetch.fetch,
        "Browser extension test",
      ),
    ).rejects.toThrow(/least-privilege/i);
  });

  it("rejects a non-browser device even if its token has write:web", async () => {
    const fetch = new FakeFetch(() =>
      jsonResponse(200, {
        device: { id: "dev_4", name: "Different client", kind: "ios" },
        token: "tok_write_web",
        scopes: ["write:web"],
      }),
    );
    await expect(
      pair("https://gateway.example.ts.net", "0123456789", fetch.fetch, "Browser extension test"),
    ).rejects.toThrow(/instead of a browser/i);
  });

  it("carries the install identity and the remembered device id only when given", async () => {
    const fetch = new FakeFetch(() =>
      jsonResponse(200, {
        device: { id: "dev_1", name: "Browser extension a1b2c3d4", kind: "browser" },
        token: "tok_write_web",
        scopes: ["write:web"],
      }),
    );
    type Caps = { capabilities: Record<string, string> };
    await pair(
      "https://gateway.example.ts.net:7600",
      "0123456789",
      fetch.fetch,
      "Browser extension test",
      {
        installId: "install-1",
        previousDeviceId: "0f1e2d3c-4b5a-4697-8877-66554433aabb",
      },
    );
    expect((pairRequests(fetch)[0].body as Caps).capabilities).toMatchObject({
      installId: "install-1",
      previousDeviceId: "0f1e2d3c-4b5a-4697-8877-66554433aabb",
    });

    await pair(
      "https://gateway.example.ts.net:7600",
      "0123456789",
      fetch.fetch,
      "Browser extension test",
    );
    const bare = (pairRequests(fetch)[1].body as Caps).capabilities;
    expect(bare).not.toHaveProperty("installId");
    expect(bare).not.toHaveProperty("previousDeviceId");
  });

  it("omits a previousDeviceId the gateway would reject instead of failing the pairing", async () => {
    const fetch = new FakeFetch(() =>
      jsonResponse(200, {
        device: { id: "dev_1", name: "Browser extension", kind: "browser" },
        token: "tok",
        scopes: ["write:web"],
      }),
    );
    await pair(
      "https://gateway.example.ts.net:7600",
      "0123456789",
      fetch.fetch,
      "Browser extension test",
      { installId: "install-1", previousDeviceId: "not-a-uuid" },
    );
    const caps = (pairRequests(fetch)[0].body as { capabilities: Record<string, string> })
      .capabilities;
    expect(caps).toMatchObject({ installId: "install-1" });
    expect(caps).not.toHaveProperty("previousDeviceId");
  });

  it("requires exactly the scope the gateway grants a browser device by default", () => {
    // A browser device's default grant lives in @omnesis/types; the extension
    // refuses any other token. If one side changes without the other, every
    // new pairing fails — this is the test that notices.
    expect(defaultScopesForDeviceKind("browser")).toEqual([REQUIRED_WEB_SCOPE]);
  });

  it("bounds a pairing request that never resolves and names the safe retry", async () => {
    const never: FetchLike = () => new Promise(() => undefined);
    await expect(
      pair("https://gateway.example.ts.net:7600", "0123456789", never, "Browser extension test", {
        requestTimeoutMs: 5,
      }),
    ).rejects.toBeInstanceOf(PairingOutcomeUnknownError);
  });

  it("sends the attempt's idempotency key so a lost response can be replayed", async () => {
    const fetch = new FakeFetch(() =>
      jsonResponse(200, {
        device: { id: "dev_1", name: "Browser extension", kind: "browser" },
        token: "tok",
        scopes: ["write:web"],
      }),
    );
    await pair("https://gateway.example.ts.net", "0123456789", fetch.fetch, "Personal", {
      idempotencyKey: "k".repeat(43),
    });
    expect(pairRequests(fetch)[0].body).toMatchObject({ idempotencyKey: "k".repeat(43) });
  });

  describe("gateway version preflight", () => {
    const paired = {
      device: { id: "dev_1", name: "Browser extension", kind: "browser" },
      token: "tok",
      scopes: ["write:web"],
    };

    it("derives the floor from the build's own minor", () => {
      expect(minimumGatewayVersionFor("0.4.5")).toBe("0.4.0");
      expect(minimumGatewayVersionFor("1.2.3-rc.1")).toBe("1.2.0");
      expect(minimumGatewayVersionFor(undefined)).toBeNull();
      expect(minimumGatewayVersionFor("dev")).toBeNull();
    });

    it("refuses a gateway on an older minor than this build before spending the code", async () => {
      const fetch = new FakeFetch((request) =>
        request.url.endsWith("/health")
          ? jsonResponse(200, { status: "ok", version: "0.3.9" })
          : jsonResponse(200, paired),
      );
      await expect(
        pair("https://gateway.example.ts.net", "0123456789", fetch.fetch, "Personal", {
          version: "0.4.5",
        }),
      ).rejects.toThrow(/runs Omnesis 0\.3\.9.*needs 0\.4\.0/);
      expect(pairRequests(fetch)).toHaveLength(0);
    });

    it("pairs with a gateway on the same minor at any patch, and with a build of unknown version", async () => {
      for (const [gateway, version] of [
        ["0.4.1", "0.4.5"],
        ["0.5.0", "0.4.5"],
        ["0.1.0", undefined],
      ] as const) {
        const fetch = new FakeFetch((request) =>
          request.url.endsWith("/health")
            ? jsonResponse(200, { status: "ok", version: gateway })
            : jsonResponse(200, paired),
        );
        const result = await pair(
          "https://gateway.example.ts.net",
          "0123456789",
          fetch.fetch,
          "Personal",
          version ? { version } : {},
        );
        expect(result.gatewayVersion).toBe(gateway);
      }
    });

    it("records the gateway's version on a successful pairing", async () => {
      const fetch = new FakeFetch((request) =>
        request.url.endsWith("/health")
          ? jsonResponse(200, { status: "ok", version: "9.9.9" })
          : jsonResponse(200, paired),
      );
      const result = await pair(
        "https://gateway.example.ts.net",
        "0123456789",
        fetch.fetch,
        "Personal",
      );
      expect(result.gatewayVersion).toBe("9.9.9");
      expect(fetch.requests[0]).toMatchObject({ method: "GET", redirect: "error" });
      expect(fetch.requests[0].url).toBe("https://gateway.example.ts.net/health");
    });

    it("leaves an unreadable health check to the pairing request itself", async () => {
      for (const health of [
        () => "network-error" as const,
        () => jsonResponse(500, { error: "boom" }),
        () => jsonResponse(200, { status: "ok" }),
        () => jsonResponse(200, { version: "not-a-version" }),
      ]) {
        const fetch = new FakeFetch((request) =>
          request.url.endsWith("/health") ? health() : jsonResponse(200, paired),
        );
        const result = await pair(
          "https://gateway.example.ts.net",
          "0123456789",
          fetch.fetch,
          "Personal",
        );
        expect(result).not.toHaveProperty("gatewayVersion");
        expect(pairRequests(fetch)).toHaveLength(1);
      }
      expect(
        await readGatewayVersion("https://gateway.example.ts.net", () =>
          Promise.reject(new Error("offline")),
        ),
      ).toBeNull();
    });

    it("gives the health check a short budget so a hanging gateway does not double the wait", async () => {
      const fetch = new FakeFetch(() => jsonResponse(200, paired));
      const hanging: FetchLike = (url, init) =>
        url.endsWith("/health") ? new Promise(() => undefined) : fetch.fetch(url, init);
      const started = Date.now();
      const result = await pair(
        "https://gateway.example.ts.net",
        "0123456789",
        hanging,
        "Personal",
        { requestTimeoutMs: 200 },
      );
      expect(result.token).toBe("tok");
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("ignores a version string that is not a bounded product version", async () => {
      for (const version of ["1.0.0-" + "x".repeat(200), "v1.2.3", "1.2", "1.2.3 extra"]) {
        expect(
          await readGatewayVersion("https://gateway.example.ts.net", () =>
            Promise.resolve(jsonResponse(200, { version })),
          ),
        ).toBeNull();
      }
      expect(
        await readGatewayVersion("https://gateway.example.ts.net", () =>
          Promise.resolve(jsonResponse(200, { version: "0.4.6-rc.1" })),
        ),
      ).toBe("0.4.6-rc.1");
    });
  });

  it("rejects an incomplete success response at the HTTP boundary", async () => {
    const fetch = new FakeFetch(() => jsonResponse(200, { token: "tok", scopes: ["write:web"] }));
    await expect(
      pair("https://gateway.example.ts.net", "0123456789", fetch.fetch, "Browser extension test"),
    ).rejects.toThrow(/missing required fields/i);
  });

  it("rejects oversized successful-response credential fields", async () => {
    const fetch = new FakeFetch(() =>
      jsonResponse(200, {
        device: { id: "dev_5", name: "Browser extension", kind: "browser" },
        token: "t".repeat(4_097),
        scopes: ["write:web"],
      }),
    );

    await expect(
      pair("https://gateway.example.ts.net", "0123456789", fetch.fetch, "Browser extension test"),
    ).rejects.toThrow(/missing required fields/i);
  });

  it("bounds composed errors from structurally valid unexpected scopes", async () => {
    const fetch = new FakeFetch(() =>
      jsonResponse(200, {
        device: { id: "dev_6", name: "Browser extension", kind: "browser" },
        token: "tok_write_web",
        scopes: Array.from({ length: 16 }, (_, index) => `${index}-${"s".repeat(120)}`),
      }),
    );

    let error: unknown;
    try {
      await pair(
        "https://gateway.example.ts.net",
        "0123456789",
        fetch.fetch,
        "Browser extension test",
      );
    } catch (candidate) {
      error = candidate;
    }

    expect(error).toBeInstanceOf(GatewayUrlError);
    expect((error as Error).message.length).toBeLessThanOrEqual(MAX_GATEWAY_REASON_CHARS);
  });
});
