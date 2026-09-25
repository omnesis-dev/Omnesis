// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { expandSpecTokens, type SerializedProviderCredentialsSpec } from "@omnesis/core";
import { resolveWizardOrigin, runCredentialsWizard } from "./credentials-wizard.js";

/**
 * Regression: the CLI wizard is the second consumer of a shared
 * credentials spec. Before this it rendered `step.body` / `field.placeholder`
 * verbatim, so an Enable Banking user saw the literal `{gatewayOrigin}` token.
 * These cover the CLI's origin resolution and confirm the shared
 * `expandSpecTokens` produces a concrete, token-free redirect URL.
 */
describe("resolveWizardOrigin", () => {
  test("prefers the configured publicBaseUrl", () => {
    const config = { config: { gateway: { publicBaseUrl: "https://gw.example.com:7600" } } };
    expect(resolveWizardOrigin(config, "https://localhost:7600")).toBe(
      "https://gw.example.com:7600",
    );
  });

  test("falls back to the origin of the CLI's gateway URL when publicBaseUrl is unset", () => {
    // The CLI has no browser origin, so its fallback is the gateway URL it talks
    // to (the host the OAuth callback server runs on) — never the empty string.
    expect(resolveWizardOrigin({ config: { gateway: {} } }, "https://localhost:7600/")).toBe(
      "https://localhost:7600",
    );
    expect(resolveWizardOrigin({}, "https://box.local:8443/portal")).toBe("https://box.local:8443");
  });

  test("returns empty string only when the gateway URL is unparseable", () => {
    expect(resolveWizardOrigin({}, "not a url")).toBe("");
  });
});

describe("wizard spec token expansion (CLI render path)", () => {
  const spec: SerializedProviderCredentialsSpec = {
    fileKey: "enable-banking",
    required: true,
    publicClient: false,
    fields: [
      {
        name: "redirect_url",
        label: "Redirect URL",
        placeholder: "{gatewayOrigin}/oauth/callback",
        default: "{gatewayOrigin}/oauth/callback",
      },
    ],
    wizard: {
      intro: "intro",
      why: "why",
      estMinutes: 10,
      steps: [
        {
          kind: "open-url",
          title: "Register",
          url: "https://example.com",
          body: "whitelist `{gatewayOrigin}/oauth/callback` — copy it exactly",
        },
      ],
    },
  };

  test("the CLI renders a concrete redirect URL, never the raw token", () => {
    const origin = resolveWizardOrigin(
      { config: { gateway: { publicBaseUrl: "https://gw.example.com:7600" } } },
      "https://localhost:7600",
    );
    const expanded = expandSpecTokens(spec, origin);

    // The exact strings the wizard prints (step body) and pre-fills (field
    // default / placeholder) must no longer contain the token.
    expect(expanded.wizard.steps[0].body).toBe(
      "whitelist `https://gw.example.com:7600/oauth/callback` — copy it exactly",
    );
    expect(expanded.fields[0].default).toBe("https://gw.example.com:7600/oauth/callback");
    expect(expanded.fields[0].placeholder).toBe("https://gw.example.com:7600/oauth/callback");

    for (const s of [expanded.wizard.steps[0].body, expanded.fields[0].default!]) {
      expect(s).not.toContain("{gatewayOrigin}");
    }
  });
});

describe("runCredentialsWizard refuses a per-account provider", () => {
  const entry = (perAccount: boolean) => ({
    fileKey: "granola",
    providerType: "granola",
    providerName: "Granola",
    configured: false,
    spec: { perAccount, fields: [] } as unknown as SerializedProviderCredentialsSpec,
  });

  test("returns false without prompting, because the write would be rejected anyway", async () => {
    // The collector refuses a provider-wide write for a per-account spec. The
    // cost of finding that out at the end is an API key the user pasted and
    // cannot read back off the screen, so the refusal has to come first.
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m?: unknown) => {
      errors.push(String(m));
    });
    try {
      await expect(
        runCredentialsWizard(entry(true), { deviceId: "d1", sameHost: true }),
      ).resolves.toBe(false);
    } finally {
      spy.mockRestore();
    }
    // It must name the commands that do work, not just say no.
    expect(errors.join("\n")).toMatch(/omnesis sources add granola/);
    expect(errors.join("\n")).toMatch(/omnesis sources reauth/);
  });
});
