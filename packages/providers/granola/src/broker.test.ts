// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrokeredCredentials,
  brokerBindingPath,
  writeBrokerBinding,
  writeCredentialBrokerConfig,
  writeProviderCredentials,
} from "@omnesis/core";
import { ProviderId } from "@omnesis/types";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import definition from "./index.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const BROKER = { kind: "nango" as const, url: "http://broker.test", secretKey: "broker-key" };
const REF = { providerConfigKey: "granola", connectionId: "conn-granola" };
const ACCOUNT = "maya.reeves@example.com";

async function brokeredConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-granola-broker-"));
  tmpDirs.push(dir);
  await writeCredentialBrokerConfig(BROKER, dir);
  await writeBrokerBinding(
    "granola",
    ACCOUNT,
    { broker: "nango", connections: { default: REF } },
    dir,
  );
  return dir;
}

/**
 * The broker hands out each of `keys` in turn (the last one thereafter);
 * Granola accepts only `accepted` and lists `notes` for it.
 */
function stubNetwork(opts: { keys: string[]; accepted?: string; notes?: unknown[] }) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  let served = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      calls.push({ url, authorization });
      if (url.startsWith(BROKER.url)) {
        const apiKey = opts.keys[Math.min(served++, opts.keys.length - 1)]!;
        return Promise.resolve(Response.json({ credentials: { type: "API_KEY", apiKey } }));
      }
      if (authorization !== `Bearer ${opts.accepted ?? opts.keys[0]}`) {
        return Promise.resolve(
          Response.json({ code: "INVALID_API_KEY", message: "Invalid API key" }, { status: 401 }),
        );
      }
      const notes = opts.notes ?? [{ id: "not_1", owner: { name: "Maya Reeves", email: ACCOUNT } }];
      return Promise.resolve(Response.json({ notes, hasMore: false, cursor: null }));
    }),
  );
  return calls;
}

async function brokeredContext(configDir: string) {
  return definition.createContext!({
    accountId: ACCOUNT,
    providerId: ProviderId(`granola:${ACCOUNT}`),
    host: fakeProviderHost({ configDir }),
  });
}

function credentialsFor(): BrokeredCredentials {
  return new BrokeredCredentials({ broker: "nango", connections: { default: REF } }, BROKER);
}

describe("Granola with a brokered key", () => {
  test("discovers the brokered account with no key on disk", async () => {
    const configDir = await brokeredConfigDir();
    expect(existsSync(join(configDir, "granola-credentials.json"))).toBe(false);
    await expect(definition.discover!({ configDir })).resolves.toEqual([
      { id: ACCOUNT, subject: { kind: "email", value: ACCOUNT } },
    ]);
  });

  test("calls Granola with the key the broker hands out, and stores none", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({ keys: ["grn_brokered_key"] });
    const context = await brokeredContext(configDir);
    await context.client.listNotes();

    const broker = calls.filter((c) => c.url.startsWith(BROKER.url));
    const granola = calls.filter((c) => c.url.startsWith("https://public-api.granola.ai"));
    expect(broker[0]!.authorization).toBe("Bearer broker-key");
    expect(granola.length).toBeGreaterThan(0);
    for (const call of granola) expect(call.authorization).toBe("Bearer grn_brokered_key");
    expect(readdirSync(join(configDir, "granola", ACCOUNT))).toEqual(["broker.json"]);
  });

  test("asks the broker again once when Granola rejects a key it rotated", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({ keys: ["grn_old_key", "grn_new_key"], accepted: "grn_new_key" });
    const context = await brokeredContext(configDir);
    await expect(context.client.listNotes()).resolves.toMatchObject({ hasMore: false });
    expect(calls.filter((c) => c.url.startsWith(BROKER.url))).toHaveLength(2);
  });

  test("still reports a key Granola keeps rejecting as an auth failure", async () => {
    const configDir = await brokeredConfigDir();
    stubNetwork({ keys: ["grn_revoked_key"], accepted: "grn_other_key" });
    const context = await brokeredContext(configDir);
    await expect(context.client.listNotes()).rejects.toMatchObject({ kind: "auth" });
  });

  test("is connected while the binding reads, and never-connected once it is removed", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({ keys: ["grn_k"] });
    const context = await brokeredContext(configDir);
    await expect(definition.credentialState!(context)).resolves.toEqual({ status: "connected" });
    await definition.cleanupCredentials!(ACCOUNT, { configDir });
    expect(existsSync(brokerBindingPath("granola", ACCOUNT, configDir))).toBe(false);
    await expect(definition.credentialState!(context)).resolves.toEqual({
      status: "never-connected",
    });
    // Nothing upstream is touched: the key is the broker's.
    expect(calls).toEqual([]);
  });

  test("removing a brokered account leaves an older install's shared key alone", async () => {
    const configDir = await brokeredConfigDir();
    await writeProviderCredentials("granola", { api_key: "grn_fictional" }, configDir);
    await definition.cleanupCredentials!(ACCOUNT, { configDir });
    expect(existsSync(join(configDir, "granola-credentials.json"))).toBe(true);
  });

  test("resolves the account to the owner's email, as a paste of the key would", async () => {
    stubNetwork({ keys: ["grn_brokered_key"] });
    await expect(definition.broker!.resolveAccount(credentialsFor(), {})).resolves.toEqual({
      accountId: ACCOUNT,
    });
  });

  test("resolves a workspace with no notes yet to the fingerprint of the key", async () => {
    stubNetwork({ keys: ["grn_empty_key"], notes: [] });
    const fingerprint = createHash("sha256").update("grn_empty_key").digest("hex").slice(0, 12);
    await expect(definition.broker!.resolveAccount(credentialsFor(), {})).resolves.toEqual({
      accountId: `granola-${fingerprint}`,
    });
  });
});
