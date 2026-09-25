// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import {
  clearSecretFileKeyCacheForTests,
  createSecretStore,
  ensureInstallRootKey,
  OMNESIS_INSTALL_ROOT_KEY,
  writeSecretJsonFile,
} from "@omnesis/core";
import { WhatsAppProvider } from "./provider.js";
import { createMockSocketFactory } from "./testing/mock-socket.js";
import {
  isOmnesisAuthUnlinked,
  promoteOmnesisMultiFileAuthState,
  quiesceOmnesisMultiFileAuthState,
  sealOmnesisMultiFileAuthState,
  useOmnesisMultiFileAuthState,
} from "./baileys-auth-state.js";
import type { SocketFactory } from "./types.js";

test("WhatsApp reports unavailable encrypted credentials as unknown", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "omnesis-wa-state-"));
  vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  const provider = new WhatsAppProvider("+15550100001", configDir);
  try {
    await expect(provider.credentialState()).resolves.toEqual({ status: "never-connected" });
    await ensureInstallRootKey({ configDir, backend: "file" });
    await writeSecretJsonFile(
      join(configDir, "whatsapp", "+15550100001", "auth", "creds.json"),
      { me: { id: "15550100001:0@s.whatsapp.net" } },
      { configDir },
    );
    await expect(provider.credentialState()).resolves.toEqual({ status: "connected" });
    await createSecretStore({ configDir, backend: "file" }).delete(OMNESIS_INSTALL_ROOT_KEY);
    clearSecretFileKeyCacheForTests();
    await expect(provider.credentialState()).resolves.toMatchObject({ status: "unknown" });
  } finally {
    await provider.disconnect();
    vi.unstubAllEnvs();
    clearSecretFileKeyCacheForTests();
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("logout persists an unlink verdict across restart and a linked recovery clears it", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "omnesis-wa-unlinked-"));
  const account = "+15550100001";
  const jid = "15550100001:0@s.whatsapp.net";
  const first = createMockSocketFactory({ meJid: jid });
  const persistedFactory = (mock: SocketFactory): SocketFactory => ({
    createSocket: async (authDir) => {
      if (!authDir) throw new Error("The provider must pass its auth directory");
      const auth = await useOmnesisMultiFileAuthState(authDir, configDir);
      return {
        ...(await mock.createSocket(authDir)),
        authDir,
        setLinkedState: auth.setLinkedState,
      };
    },
  });
  const provider = new WhatsAppProvider(account, configDir, persistedFactory(first.factory));
  const recovered = createMockSocketFactory({ meJid: jid });
  const reopened = new WhatsAppProvider(account, configDir, persistedFactory(recovered.factory));
  try {
    await writeSecretJsonFile(
      join(configDir, "whatsapp", account, "auth", "creds.json"),
      { me: { id: jid } },
      { configDir },
    );
    const auth = provider.authenticate();
    const rejection = expect(auth).rejects.toThrow("WhatsApp logged out");
    await vi.waitFor(() => expect(first.createSocketCount()).toBe(1));
    first.emitter.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await rejection;
    await expect(provider.credentialState()).resolves.toMatchObject({ status: "unlinked" });
    await expect(reopened.credentialState()).resolves.toMatchObject({ status: "unlinked" });
    await expect(reopened.isAuthenticated()).resolves.toBe(false);
    await provider.disconnect();
    await expect(reopened.credentialState()).resolves.toMatchObject({ status: "unlinked" });
    const authRecovery = reopened.authenticate();
    await vi.waitFor(() => expect(recovered.createSocketCount()).toBe(1));
    recovered.emitter.emit("connection.update", { connection: "open" });
    await authRecovery;
    // Clearing the marker is deliberately not awaited by the connection-open
    // handler: blocking there holds back the `messaging-history.set`
    // subscription past WhatsApp's first history batches. The guarantee is
    // that it clears, not that it clears before the connection resolves.
    await vi.waitFor(async () =>
      expect(await reopened.credentialState()).toEqual({ status: "connected" }),
    );
  } finally {
    await provider.disconnect();
    await reopened.disconnect();
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("a stale auth writer cannot unlink a replacement generation", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "omnesis-wa-unlink-fence-"));
  const authDir = join(configDir, "whatsapp", "+15550100001", "auth");
  try {
    const first = await useOmnesisMultiFileAuthState(authDir, configDir);
    await first.setLinkedState(false);
    await quiesceOmnesisMultiFileAuthState(authDir);
    expect(await isOmnesisAuthUnlinked(authDir)).toBe(true);
    const stagingDir = join(configDir, "whatsapp", "_fixture-pairing", "auth");
    const staged = await useOmnesisMultiFileAuthState(stagingDir, configDir);
    staged.state.creds.me = { id: "15550100001:0@s.whatsapp.net" };
    await staged.saveCreds();
    await sealOmnesisMultiFileAuthState(stagingDir);
    await promoteOmnesisMultiFileAuthState(stagingDir, authDir, configDir);
    await first.setLinkedState(false);
    expect(await isOmnesisAuthUnlinked(authDir)).toBe(false);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
