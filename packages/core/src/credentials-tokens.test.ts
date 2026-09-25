// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";
import {
  resolveGatewayOrigin,
  expandGatewayOriginToken,
  expandSpecTokens,
  publicBaseUrlFromAdminConfig,
} from "./credentials-tokens.js";
import type { SerializedProviderCredentialsSpec } from "./credentials.js";

describe("publicBaseUrlFromAdminConfig", () => {
  // GET /admin/config wraps the config as { config, version }; the value must
  // be read at response.config.gateway.publicBaseUrl, not one level shallower.
  test("reads publicBaseUrl from the nested { config } envelope", () => {
    const response = {
      config: { gateway: { publicBaseUrl: "https://gw.example.com:7600" } },
      version: 3,
    };
    expect(publicBaseUrlFromAdminConfig(response)).toBe("https://gw.example.com:7600");
  });

  test("does NOT read from the response root (regression for the shape bug)", () => {
    // The old code read response.gateway.publicBaseUrl — a top-level `gateway`
    // must be ignored so a stray value there can't mask the real one.
    const response = { gateway: { publicBaseUrl: "https://wrong.example.com" } } as never;
    expect(publicBaseUrlFromAdminConfig(response)).toBeUndefined();
  });

  test("returns undefined when publicBaseUrl is unset", () => {
    expect(publicBaseUrlFromAdminConfig({ config: { gateway: {} } })).toBeUndefined();
    expect(publicBaseUrlFromAdminConfig({ config: {} })).toBeUndefined();
  });

  test("tolerates a missing / empty response", () => {
    expect(publicBaseUrlFromAdminConfig(undefined)).toBeUndefined();
    expect(publicBaseUrlFromAdminConfig({})).toBeUndefined();
  });
});

describe("resolveGatewayOrigin", () => {
  const originalWindow = global.window;
  afterEach(() => {
    global.window = originalWindow;
  });

  test("prefers publicBaseUrl when set", () => {
    expect(resolveGatewayOrigin("https://gw.example.com:7600")).toBe("https://gw.example.com:7600");
  });

  test("falls back to the browser origin when publicBaseUrl is unset", () => {
    // @ts-expect-error — minimal window stub for the fallback path
    global.window = { location: { origin: "https://portal.example.com:8443" } };
    expect(resolveGatewayOrigin(undefined)).toBe("https://portal.example.com:8443");
  });

  test("publicBaseUrl still wins over the browser origin", () => {
    // @ts-expect-error — minimal window stub
    global.window = { location: { origin: "https://portal.example.com:8443" } };
    expect(resolveGatewayOrigin("https://gw.example.com:7600")).toBe("https://gw.example.com:7600");
  });

  test("returns empty string when neither is available (non-browser env)", () => {
    // @ts-expect-error — intentionally removing window for the Node path
    delete global.window;
    expect(resolveGatewayOrigin(undefined)).toBe("");
  });
});

describe("expandGatewayOriginToken", () => {
  const origin = "https://gw.example.com:7600";

  test("replaces a single {gatewayOrigin} token, scheme included", () => {
    expect(expandGatewayOriginToken("{gatewayOrigin}/oauth/callback", origin)).toBe(
      "https://gw.example.com:7600/oauth/callback",
    );
  });

  test("does not double the scheme (token carries https://)", () => {
    // Regression: the descriptor must reference {gatewayOrigin}/… without a
    // literal https:// prefix, so expansion yields a single scheme.
    const expanded = expandGatewayOriginToken("{gatewayOrigin}/oauth/callback", origin);
    expect(expanded.match(/https:\/\//g)).toHaveLength(1);
  });

  test("replaces multiple tokens", () => {
    expect(expandGatewayOriginToken("{gatewayOrigin} and {gatewayOrigin}", origin)).toBe(
      "https://gw.example.com:7600 and https://gw.example.com:7600",
    );
  });

  test("leaves text without a token unchanged", () => {
    expect(expandGatewayOriginToken("no token here", origin)).toBe("no token here");
  });

  test("handles empty / nullish text", () => {
    expect(expandGatewayOriginToken("", origin)).toBe("");
    // @ts-expect-error — nullish input is tolerated
    expect(expandGatewayOriginToken(undefined, origin)).toBe("");
  });
});

describe("expandSpecTokens", () => {
  const origin = "https://gw.example.com:7600";
  const baseSpec: SerializedProviderCredentialsSpec = {
    fileKey: "test-provider",
    required: true,
    publicClient: false,
    fields: [
      {
        name: "redirect_url",
        label: "Redirect URL",
        placeholder: "{gatewayOrigin}/oauth/callback",
        default: "{gatewayOrigin}/oauth/callback",
      },
      { name: "client_id", label: "Client ID", placeholder: "e.g. abc123" },
    ],
    wizard: {
      intro: "Setup wizard",
      why: "Connects your account",
      estMinutes: 5,
      steps: [
        {
          kind: "instruction",
          title: "Step 1",
          body: "Whitelist `{gatewayOrigin}/oauth/callback`.",
        },
        { kind: "instruction", title: "Step 2", body: "No token on this step." },
      ],
    },
  };

  test("expands the token in field placeholders and defaults", () => {
    const result = expandSpecTokens(baseSpec, origin);
    expect(result.fields[0].placeholder).toBe("https://gw.example.com:7600/oauth/callback");
    expect(result.fields[0].default).toBe("https://gw.example.com:7600/oauth/callback");
  });

  test("expands the token in step bodies", () => {
    const result = expandSpecTokens(baseSpec, origin);
    expect(result.wizard.steps[0].body).toBe(
      "Whitelist `https://gw.example.com:7600/oauth/callback`.",
    );
  });

  test("leaves fields and steps without a token untouched", () => {
    const result = expandSpecTokens(baseSpec, origin);
    expect(result.fields[1].placeholder).toBe("e.g. abc123");
    expect(result.wizard.steps[1].body).toBe("No token on this step.");
  });

  test("a token-free spec is returned structurally unchanged", () => {
    const spec: SerializedProviderCredentialsSpec = {
      fileKey: "p",
      required: true,
      publicClient: false,
      fields: [{ name: "client_id", label: "Client ID", placeholder: "abc123" }],
      wizard: {
        intro: "Intro",
        why: "Why",
        estMinutes: 1,
        steps: [{ kind: "instruction", title: "Step 1", body: "No tokens." }],
      },
    };
    const result = expandSpecTokens(spec, origin);
    expect(result.fields[0].placeholder).toBe("abc123");
    expect(result.wizard.steps[0].body).toBe("No tokens.");
  });

  test("does not mutate the input spec", () => {
    expandSpecTokens(baseSpec, origin);
    expect(baseSpec.fields[0].default).toBe("{gatewayOrigin}/oauth/callback");
    expect(baseSpec.wizard.steps[0].body).toBe("Whitelist `{gatewayOrigin}/oauth/callback`.");
  });
});
