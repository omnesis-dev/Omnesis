// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrokeredCredentials,
  brokerBindingPath,
  writeBrokerBinding,
  writeCredentialBrokerConfig,
  writeProviderAccountCredentials,
  writeProviderCredentials,
  type BrokerConnectionRef,
} from "@omnesis/core";
import { ProviderId } from "@omnesis/types";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { deriveAccountId, resolveBrokeredAccount } from "./provider.js";
import definition from "./index.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const BROKER = { kind: "nango" as const, url: "http://broker.test", secretKey: "broker-key" };
const REF = { providerConfigKey: "private-api-generic", connectionId: "conn-lunchflow" };
const ACCOUNT = String(deriveAccountId("lf_key_linked"));

async function brokeredConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-lunchflow-broker-"));
  tmpDirs.push(dir);
  await writeCredentialBrokerConfig(BROKER, dir);
  await writeBrokerBinding(
    "lunchflow",
    ACCOUNT,
    { broker: "nango", connections: { default: REF } },
    dir,
  );
  return dir;
}

function bankAccount(id: number) {
  return {
    id,
    name: `Everyday ${id}`,
    institution_name: "Northstar",
    institution_logo: null,
    provider: "gocardless",
  };
}

/**
 * The broker hands out each connection's keys in turn (the last one
 * thereafter); Lunch Flow lists the banks a key reaches and refuses any key it
 * does not know.
 */
function stubNetwork(opts: { keys: Record<string, string[]>; banks: Record<string, number[]> }) {
  const calls: Array<{ url: string; authorization: string | null; apiKey: string | null }> = [];
  const served = new Map<string, number>();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        authorization: headers.get("authorization"),
        apiKey: headers.get("x-api-key"),
      });
      if (url.startsWith(BROKER.url)) {
        const connection = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
        const keys = opts.keys[connection] ?? [];
        const n = served.get(connection) ?? 0;
        served.set(connection, n + 1);
        const apiKey = keys[Math.min(n, keys.length - 1)];
        if (!apiKey) return Promise.resolve(Response.json({ error: "unknown" }, { status: 404 }));
        return Promise.resolve(Response.json({ credentials: { type: "API_KEY", apiKey } }));
      }
      const banks = opts.banks[headers.get("x-api-key") ?? ""];
      if (!banks) {
        return Promise.resolve(Response.json({ error: "Unauthorized" }, { status: 401 }));
      }
      return Promise.resolve(
        Response.json({ accounts: banks.map(bankAccount), total: banks.length }),
      );
    }),
  );
  return calls;
}

async function brokeredContext(configDir: string) {
  return definition.createContext!({
    accountId: ACCOUNT,
    providerId: ProviderId(`lunchflow:${ACCOUNT}`),
    host: fakeProviderHost({ configDir }),
  });
}

function credentialsFor(ref: BrokerConnectionRef = REF): BrokeredCredentials {
  return new BrokeredCredentials({ broker: "nango", connections: { default: ref } }, BROKER);
}

describe("Lunch Flow with a brokered key", () => {
  test("discovers the brokered account with no key on disk", async () => {
    const configDir = await brokeredConfigDir();
    expect(existsSync(join(configDir, "lunchflow-credentials.json"))).toBe(false);
    await expect(definition.discover!({ configDir })).resolves.toEqual([ACCOUNT]);
  });

  test("keeps an older install's unrecorded `default` account beside a brokered one", async () => {
    const configDir = await brokeredConfigDir();
    await writeProviderCredentials("lunchflow", { api_key: "lf_key_legacy" }, configDir);
    await expect(definition.discover!({ configDir })).resolves.toEqual(["default", ACCOUNT]);
  });

  test("calls Lunch Flow with the key the broker hands out, and stores none", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({
      keys: { "conn-lunchflow": ["lf_key_linked"] },
      banks: { lf_key_linked: [481] },
    });
    const context = await brokeredContext(configDir);
    await expect(context.client.listAccounts()).resolves.toHaveLength(1);

    const broker = calls.filter((c) => c.url.startsWith(BROKER.url));
    const lunchflow = calls.filter((c) => c.url.startsWith("https://www.lunchflow.app"));
    expect(broker[0]!.authorization).toBe("Bearer broker-key");
    expect(lunchflow.length).toBeGreaterThan(0);
    for (const call of lunchflow) expect(call.apiKey).toBe("lf_key_linked");
    expect(readdirSync(join(configDir, "lunchflow", ACCOUNT))).toEqual(["broker.json"]);
  });

  test("asks the broker again once when Lunch Flow rejects a key it rotated", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({
      keys: { "conn-lunchflow": ["lf_key_linked", "lf_key_rotated"] },
      banks: { lf_key_rotated: [481] },
    });
    const context = await brokeredContext(configDir);
    await expect(context.client.listAccounts()).resolves.toHaveLength(1);
    expect(calls.filter((c) => c.url.startsWith(BROKER.url))).toHaveLength(2);
    // The account keeps the id derived from the key it was linked with.
    await expect(definition.discover!({ configDir })).resolves.toEqual([ACCOUNT]);
  });

  test("still reports a key Lunch Flow keeps rejecting as an auth failure", async () => {
    const configDir = await brokeredConfigDir();
    stubNetwork({ keys: { "conn-lunchflow": ["lf_key_revoked"] }, banks: {} });
    const context = await brokeredContext(configDir);
    await expect(context.client.listAccounts()).rejects.toMatchObject({ kind: "auth" });
  });

  test("is connected while the binding reads, and never-connected once it is removed", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({ keys: {}, banks: {} });
    const context = await brokeredContext(configDir);
    await expect(definition.credentialState!(context)).resolves.toEqual({ status: "connected" });
    await definition.cleanupCredentials!(ACCOUNT, { configDir });
    expect(existsSync(brokerBindingPath("lunchflow", ACCOUNT, configDir))).toBe(false);
    await expect(definition.credentialState!(context)).resolves.toEqual({
      status: "never-connected",
    });
    // Nothing upstream is touched: the key is the broker's.
    expect(calls).toEqual([]);
  });

  test("removing a brokered account leaves an older install's shared key alone", async () => {
    const configDir = await brokeredConfigDir();
    await writeProviderCredentials("lunchflow", { api_key: "lf_key_legacy" }, configDir);
    await definition.cleanupCredentials!(ACCOUNT, { configDir });
    expect(existsSync(join(configDir, "lunchflow-credentials.json"))).toBe(true);
    await expect(definition.discover!({ configDir })).resolves.toEqual(["default"]);
  });

  test("resolves the account to the hash of the key, as a paste of it would", async () => {
    stubNetwork({ keys: { "conn-lunchflow": ["lf_key_linked"] }, banks: { lf_key_linked: [] } });
    await expect(definition.broker!.resolveAccount(credentialsFor(), {})).resolves.toEqual({
      accountId: ACCOUNT,
    });
  });

  test("refuses to link a key Lunch Flow does not accept", async () => {
    stubNetwork({ keys: { "conn-lunchflow": ["lf_key_revoked"] }, banks: {} });
    await expect(definition.broker!.resolveAccount(credentialsFor(), {})).rejects.toMatchObject({
      kind: "auth",
    });
  });

  describe("given the config directory, refuses a key whose banks are already connected", () => {
    test("under a pasted key", async () => {
      const configDir = await brokeredConfigDir();
      await writeProviderAccountCredentials(
        "lunchflow",
        String(deriveAccountId("lf_key_pasted")),
        { api_key: "lf_key_pasted" },
        configDir,
      );
      const other = { providerConfigKey: "private-api-generic", connectionId: "conn-other" };
      stubNetwork({
        keys: { "conn-lunchflow": ["lf_key_linked"], "conn-other": ["lf_key_other"] },
        banks: { lf_key_linked: [7], lf_key_pasted: [481], lf_key_other: [481, 9] },
      });
      await expect(resolveBrokeredAccount(credentialsFor(other), { configDir })).rejects.toThrow(
        String(deriveAccountId("lf_key_pasted")),
      );
    });

    test("under another brokered key, read from the broker and not from disk", async () => {
      const configDir = await brokeredConfigDir();
      // An older install's shared key, which reading the sibling from disk
      // would have adopted into the brokered account's directory.
      await writeProviderCredentials("lunchflow", { api_key: "lf_key_legacy" }, configDir);
      const other = { providerConfigKey: "private-api-generic", connectionId: "conn-other" };
      stubNetwork({
        keys: { "conn-lunchflow": ["lf_key_linked"], "conn-other": ["lf_key_other"] },
        banks: { lf_key_linked: [481], lf_key_other: [481], lf_key_legacy: [] },
      });
      await expect(resolveBrokeredAccount(credentialsFor(other), { configDir })).rejects.toThrow(
        ACCOUNT,
      );
      expect(readdirSync(join(configDir, "lunchflow", ACCOUNT))).toEqual(["broker.json"]);
    });

    test("but not when re-linking the same account", async () => {
      const configDir = await brokeredConfigDir();
      stubNetwork({
        keys: { "conn-lunchflow": ["lf_key_linked"] },
        banks: { lf_key_linked: [481] },
      });
      await expect(resolveBrokeredAccount(credentialsFor(), { configDir })).resolves.toEqual({
        accountId: ACCOUNT,
      });
    });
  });
});
