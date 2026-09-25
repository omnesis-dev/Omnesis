// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  integrationCredentialsSchema,
  loadIntegrationCredentials,
  upgradeLegacyIntegrationCredentials,
  updateIntegrationOAuthState,
} from "./credentials.js";

const runtimeCredentials = {
  gatewayUrl: "https://gateway.example.org:7600",
  deliveryToken: "omn_delivery_example",
  ingestionToken: "omn_ingestion_example",
  managementToken: "omn_management_example",
  oauth: {
    redirectUri: "http://127.0.0.1:48123/callback",
    clientInformation: { client_id: "client_fictional" },
    tokens: {
      access_token: "principal_access_fictional",
      refresh_token: "principal_refresh_fictional",
      token_type: "Bearer",
    },
  },
  tls: {
    caPem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n",
    leafFingerprintSha256: "a".repeat(64),
  },
  maxConcurrentRuns: 2,
};

describe("integration credentials", () => {
  test("separates operational authority from principal OAuth material", () => {
    expect(integrationCredentialsSchema.parse(runtimeCredentials)).toEqual(runtimeCredentials);
    expect(() =>
      integrationCredentialsSchema.parse({
        ...runtimeCredentials,
        principalToken: "omn_principal_example",
      }),
    ).toThrow();
  });

  test("rejects unexpected credential fields", () => {
    expect(() =>
      integrationCredentialsSchema.parse({
        ...runtimeCredentials,
        adminToken: "omn_admin_example",
      }),
    ).toThrow();
  });

  test("loads the strict native runtime credential file", () => {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-integration-credentials-"));
    try {
      const runtimePath = join(directory, "integration.json");
      writeFileSync(runtimePath, JSON.stringify(runtimeCredentials));
      expect(loadIntegrationCredentials(runtimePath)).toEqual(runtimeCredentials);
      writeFileSync(
        runtimePath,
        JSON.stringify({ ...runtimeCredentials, adminToken: "omn_admin" }),
      );
      expect(() => loadIntegrationCredentials(runtimePath)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("atomically persists refreshed OAuth state with mode 0600", () => {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-integration-oauth-"));
    try {
      const runtimePath = join(directory, "integration.json");
      writeFileSync(runtimePath, JSON.stringify(runtimeCredentials), { mode: 0o644 });
      updateIntegrationOAuthState(runtimePath, {
        ...runtimeCredentials.oauth,
        tokens: { ...runtimeCredentials.oauth.tokens, access_token: "principal_access_refreshed" },
      });
      expect(loadIntegrationCredentials(runtimePath).oauth.tokens.access_token).toBe(
        "principal_access_refreshed",
      );
      expect(statSync(runtimePath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("upgrades legacy plugin state without rotating operational device credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-integration-upgrade-"));
    try {
      const runtimePath = join(directory, "integration.json");
      writeFileSync(
        runtimePath,
        JSON.stringify({
          gatewayUrl: runtimeCredentials.gatewayUrl,
          deliveryToken: runtimeCredentials.deliveryToken,
          ingestionToken: runtimeCredentials.ingestionToken,
          maxConcurrentRuns: 2,
        }),
        { mode: 0o600 },
      );
      const upgraded = upgradeLegacyIntegrationCredentials(
        runtimePath,
        runtimeCredentials.managementToken,
      );
      expect(upgraded).toMatchObject({
        deliveryToken: runtimeCredentials.deliveryToken,
        ingestionToken: runtimeCredentials.ingestionToken,
        managementToken: runtimeCredentials.managementToken,
        oauth: {
          redirectUri: "http://127.0.0.1:0/callback",
          clientInformation: {},
          tokens: {},
        },
      });
      expect(statSync(runtimePath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
