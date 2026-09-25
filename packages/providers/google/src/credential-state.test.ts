// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import {
  clearSecretFileKeyCacheForTests,
  createSecretStore,
  ensureInstallRootKey,
  OMNESIS_INSTALL_ROOT_KEY,
  writeProviderCredentials,
  writeSecretJsonFile,
} from "@omnesis/core";
import { GoogleProvider } from "./provider.js";

test("Google cached tokens do not misreport locked storage as connected", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "omnesis-google-state-"));
  vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  try {
    await ensureInstallRootKey({ configDir, backend: "file" });
    await writeProviderCredentials(
      "google",
      { client_id: "fictional-client", client_secret: "fictional-secret" },
      configDir,
    );
    const path = join(configDir, "google", "fixture@example.com", "tokens.json");
    await writeSecretJsonFile(
      path,
      { access_token: "fictional-access", refresh_token: "fictional-refresh" },
      { configDir },
    );
    const provider = new GoogleProvider("fixture@example.com", configDir);
    await provider.initialize();
    await expect(provider.credentialState()).resolves.toEqual({ status: "connected" });
    const secrets = createSecretStore({ configDir, backend: "file" });
    await secrets.delete(OMNESIS_INSTALL_ROOT_KEY);
    clearSecretFileKeyCacheForTests();
    await expect(provider.credentialState()).resolves.toMatchObject({ status: "unknown" });
    await rm(path);
    await expect(provider.credentialState()).resolves.toEqual({ status: "never-connected" });
  } finally {
    vi.unstubAllEnvs();
    clearSecretFileKeyCacheForTests();
    await rm(configDir, { recursive: true, force: true });
  }
});
