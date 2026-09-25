// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import {
  clearSecretFileKeyCacheForTests,
  createSecretStore,
  ensureInstallRootKey,
  OMNESIS_INSTALL_ROOT_KEY,
  writeSecretJsonFile,
} from "@omnesis/core";
import coinbase from "@omnesis/provider-coinbase";
import github from "@omnesis/provider-github";
import granola from "@omnesis/provider-granola";
import lunchflow from "@omnesis/provider-lunchflow";
import notion from "@omnesis/provider-notion";
import strava from "@omnesis/provider-strava";
import imap from "@omnesis/provider-imap";
import enableBanking from "@omnesis/provider-enable-banking";
import plaid from "@omnesis/provider-plaid";

const fixtures = [
  {
    definition: coinbase,
    file: "credentials.json",
    fields: { key_id: "fictional-id", private_key: "fictional-key" },
  },
  { definition: github, file: "credentials.json", fields: { token: "fictional-token" } },
  { definition: granola, file: "credentials.json", fields: { api_key: "fictional-key" } },
  { definition: lunchflow, file: "credentials.json", fields: { api_key: "fictional-key" } },
  { definition: notion, file: "tokens.json", fields: { access_token: "fictional-token" } },
  {
    definition: strava,
    file: "tokens.json",
    fields: { access_token: "fictional-token", refresh_token: "fictional-refresh" },
  },
  {
    definition: imap,
    file: "credentials.json",
    fields: {
      host: "imap.example.com",
      username: "fixture@example.com",
      app_password: "fictional-app-password",
    },
  },
  {
    definition: enableBanking,
    file: "session.json",
    fields: {
      session_id: "fictional-consent",
      valid_until: "2030-01-01T00:00:00Z",
      aspsp: { name: "Example bank", country: "GB" },
      accounts: [],
    },
  },
  {
    definition: plaid,
    file: "item.json",
    fields: { item_id: "fixture@example.com", access_token: "fictional-token" },
  },
];
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearSecretFileKeyCacheForTests();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test.each(fixtures)(
  "$definition.provider.id: locked secret storage is unknown, not missing or connected",
  async ({ definition, file, fields }) => {
    const configDir = await mkdtemp(join(tmpdir(), "omnesis-credential-status-"));
    dirs.push(configDir);
    vi.stubEnv("OMNESIS_SECRET_STORE", "file");
    const fetch = vi.fn(() => {
      throw new Error("Credential status must not use the network");
    });
    vi.stubGlobal("fetch", fetch);
    const ctx = {
      accountId: "fixture@example.com",
      configDir,
      now: () => new Date("2026-01-01T00:00:00Z"),
    };
    // These hooks inspect credential storage only; no upstream client is constructed.
    const state = () => definition.credentialState!(ctx as never);
    expect(await state()).toEqual({ status: "never-connected" });
    await ensureInstallRootKey({ configDir, backend: "file" });
    await writeSecretJsonFile(
      join(configDir, definition.provider.id, ctx.accountId, file),
      fields,
      { configDir },
    );
    if (definition.provider.id === "plaid") {
      await writeSecretJsonFile(
        join(configDir, "plaid-credentials.json"),
        {
          client_id: "fictional-client",
          secret: "fictional-secret",
          environment: "sandbox",
          countries: "GB",
        },
        { configDir },
      );
    }
    expect(await state()).toMatchObject({ status: "connected" });
    await createSecretStore({ configDir, backend: "file" }).delete(OMNESIS_INSTALL_ROOT_KEY);
    clearSecretFileKeyCacheForTests();
    expect(await state()).toMatchObject({ status: "unknown", because: expect.any(String) });
    expect(fetch).not.toHaveBeenCalled();
  },
);
