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
const PAT_REF = { providerConfigKey: "github-pat", connectionId: "conn-github" };
const OAUTH_REF = { providerConfigKey: "github", connectionId: "conn-github-oauth" };
const ACCOUNT = "maya-reeves@acme-org";

async function brokeredConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-github-broker-"));
  tmpDirs.push(dir);
  await writeCredentialBrokerConfig(BROKER, dir);
  await writeBrokerBinding(
    "github",
    ACCOUNT,
    { broker: "nango", connections: { default: PAT_REF }, params: { accountLabel: "acme-org" } },
    dir,
  );
  return dir;
}

/**
 * The broker hands out each of `keys` in turn (the last one thereafter), as an
 * API key or an OAuth token; GitHub accepts only `accepted`.
 */
function stubNetwork(opts: { keys: string[]; accepted?: string; oauth?: boolean }) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  let served = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      calls.push({ url, authorization });
      if (url.startsWith(BROKER.url)) {
        const key = opts.keys[Math.min(served++, opts.keys.length - 1)]!;
        return Promise.resolve(
          Response.json({
            credentials: opts.oauth
              ? { type: "OAUTH2", access_token: key, raw: { token_type: "bearer" } }
              : { type: "API_KEY", apiKey: key },
          }),
        );
      }
      const accepted = opts.accepted ?? opts.keys[0];
      if (authorization !== `Bearer ${accepted}`) {
        return Promise.resolve(Response.json({ message: "Bad credentials" }, { status: 401 }));
      }
      return Promise.resolve(Response.json({ login: "Maya-Reeves", name: "Maya Reeves" }));
    }),
  );
  return calls;
}

async function brokeredContext(configDir: string) {
  return definition.createContext!({
    accountId: ACCOUNT,
    providerId: ProviderId(`github:${ACCOUNT}`),
    host: fakeProviderHost({ configDir }),
  });
}

describe("GitHub with a brokered credential", () => {
  test("discovers the brokered account, login and label, with no token on disk", async () => {
    const configDir = await brokeredConfigDir();
    expect(existsSync(join(configDir, "github-credentials.json"))).toBe(false);
    await expect(definition.discover!({ configDir })).resolves.toEqual([
      {
        id: ACCOUNT,
        subject: { kind: "handle", value: "maya-reeves" },
        tenant: { id: "acme-org" },
      },
    ]);
  });

  test("calls GitHub with the token the broker hands out, and stores none", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({ keys: ["github_pat_brokered"] });
    const context = await brokeredContext(configDir);
    await expect(context.client.getUser()).resolves.toMatchObject({ login: "Maya-Reeves" });

    const broker = calls.filter((c) => c.url.startsWith(BROKER.url));
    const github = calls.filter((c) => c.url.startsWith("https://api.github.com"));
    expect(broker[0]!.authorization).toBe("Bearer broker-key");
    expect(github.length).toBeGreaterThan(0);
    for (const call of github) expect(call.authorization).toBe("Bearer github_pat_brokered");
    expect(readdirSync(join(configDir, "github", ACCOUNT))).toEqual(["broker.json"]);
  });

  test("asks the broker again once when GitHub rejects a token it rotated", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({
      keys: ["github_pat_old", "github_pat_new"],
      accepted: "github_pat_new",
    });
    const context = await brokeredContext(configDir);
    await expect(context.client.getUser()).resolves.toMatchObject({ login: "Maya-Reeves" });
    expect(calls.filter((c) => c.url.startsWith(BROKER.url))).toHaveLength(2);
    expect(calls.filter((c) => c.url.startsWith("https://api.github.com"))).toHaveLength(2);
  });

  test("still reports a token GitHub keeps rejecting as an auth failure", async () => {
    const configDir = await brokeredConfigDir();
    stubNetwork({ keys: ["github_pat_revoked"], accepted: "github_pat_other" });
    const context = await brokeredContext(configDir);
    await expect(context.client.getUser()).rejects.toMatchObject({ kind: "auth" });
  });

  test("is connected while the binding reads, and never-connected once it is removed", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({ keys: ["t"] });
    const context = await brokeredContext(configDir);
    await expect(definition.credentialState!(context)).resolves.toEqual({ status: "connected" });
    await definition.cleanupCredentials!(ACCOUNT, { configDir });
    expect(existsSync(brokerBindingPath("github", ACCOUNT, configDir))).toBe(false);
    await expect(definition.credentialState!(context)).resolves.toEqual({
      status: "never-connected",
    });
    // Nothing upstream is touched: the grant is the broker's.
    expect(calls).toEqual([]);
  });

  test("removing a brokered account leaves an older install's shared token alone", async () => {
    const configDir = await brokeredConfigDir();
    await writeProviderCredentials("github", { token: "ghp_fictional" }, configDir);
    await definition.cleanupCredentials!(ACCOUNT, { configDir });
    expect(existsSync(join(configDir, "github-credentials.json"))).toBe(true);
  });

  test("resolves the account to the login, labelled as the operator names it", async () => {
    stubNetwork({ keys: ["gho_brokered"], oauth: true });
    const credentials = new BrokeredCredentials(
      { broker: "nango", connections: { default: OAUTH_REF } },
      BROKER,
    );
    await expect(definition.broker!.resolveAccount(credentials, {})).resolves.toEqual({
      accountId: "maya-reeves",
    });
    await expect(
      definition.broker!.resolveAccount(credentials, { accountLabel: " Acme-Org " }),
    ).resolves.toEqual({ accountId: ACCOUNT });
    await expect(
      definition.broker!.resolveAccount(credentials, { accountLabel: "acme/org" }),
    ).rejects.toThrow(/not usable/);
  });
});
