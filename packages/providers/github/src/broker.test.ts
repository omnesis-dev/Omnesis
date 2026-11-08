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
import { verifyGithubIdentity } from "./provider.js";
import definition from "./index.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const BROKER = { kind: "nango" as const, url: "http://127.0.0.1:3999", secretKey: "broker-key" };
const PAT_REF = { providerConfigKey: "github-pat", connectionId: "conn-github" };
const OAUTH_REF = { providerConfigKey: "github", connectionId: "conn-github-oauth" };
const ACCOUNT = "maya-reeves@acme-org";
const MAYA_ID = 4101;
const LINKED = {
  broker: "nango" as const,
  connections: { default: PAT_REF },
  params: { accountLabel: "acme-org", userId: String(MAYA_ID) },
};

async function brokeredConfigDir(
  params: Record<string, string> = { accountLabel: "acme-org", userId: String(MAYA_ID) },
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-github-broker-"));
  tmpDirs.push(dir);
  await writeCredentialBrokerConfig(BROKER, dir);
  await writeBrokerBinding(
    "github",
    ACCOUNT,
    { broker: "nango", connections: { default: PAT_REF }, params },
    dir,
  );
  return dir;
}

/**
 * The broker hands out each of `keys` in turn (the last one thereafter), as an
 * API key or an OAuth token; GitHub accepts only `accepted`.
 */
function stubNetwork(opts: {
  keys: string[];
  accepted?: string;
  oauth?: boolean;
  /** The user GitHub reports for a token, when not Maya. */
  users?: Record<string, { login: string; id: number }>;
}) {
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
      if (!authorization || authorization !== `Bearer ${accepted}`) {
        return Promise.resolve(Response.json({ message: "Bad credentials" }, { status: 401 }));
      }
      const user = opts.users?.[authorization.slice("Bearer ".length)] ?? {
        login: "Maya-Reeves",
        id: MAYA_ID,
      };
      if (!url.endsWith("/user")) return Promise.resolve(Response.json([]));
      return Promise.resolve(Response.json({ ...user, name: user.login }));
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
    const network = { keys: ["github_pat_old", "github_pat_new"], accepted: "github_pat_old" };
    const calls = stubNetwork(network);
    const context = await brokeredContext(configDir);
    await expect(context.client.getUser()).resolves.toMatchObject({ login: "Maya-Reeves" });
    network.accepted = "github_pat_new";
    await expect(context.client.getUser()).resolves.toMatchObject({ login: "Maya-Reeves" });
    expect(calls.filter((c) => c.url.startsWith(BROKER.url))).toHaveLength(2);
    // Each token is checked once, then used; the rotated-away one is refused once.
    expect(
      calls.filter((c) => c.url.startsWith("https://api.github.com")).map((c) => c.authorization),
    ).toEqual([
      "Bearer github_pat_old",
      "Bearer github_pat_old",
      "Bearer github_pat_old",
      "Bearer github_pat_new",
      "Bearer github_pat_new",
    ]);
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
      params: { userId: String(MAYA_ID) },
    });
    await expect(
      definition.broker!.resolveAccount(credentials, { accountLabel: " Acme-Org " }),
    ).resolves.toEqual({ accountId: ACCOUNT, params: { userId: String(MAYA_ID) } });
    await expect(
      definition.broker!.resolveAccount(credentials, { accountLabel: "acme/org" }),
    ).rejects.toThrow(/not usable/);
  });
});

describe("GitHub brokered connections are re-checked against the linked user", () => {
  test("an unchanged login syncs, asking GitHub once per token who it is", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({ keys: ["github_pat_brokered"] });
    const context = await brokeredContext(configDir);
    await expect(context.client.listAccessibleRepos()).resolves.toEqual([]);
    await expect(context.client.listAccessibleRepos()).resolves.toEqual([]);
    const github = calls.filter((c) => c.url.startsWith("https://api.github.com"));
    expect(github.map((c) => new URL(c.url).pathname)).toEqual([
      "/user",
      "/user/repos",
      "/user/repos",
    ]);
  });

  test("a token that is now another user's stops with identity-changed before anything is read", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork({
      keys: ["github_pat_swapped"],
      users: { github_pat_swapped: { login: "jamie-lopez", id: 5202 } },
    });
    const context = await brokeredContext(configDir);
    const failure = await context.client.listAccessibleRepos().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toMatchObject({
      name: "BrokerCredentialError",
      reason: "identity-changed",
      kind: "auth",
    });
    expect((failure as Error).message).not.toContain("jamie-lopez");
    expect(
      calls
        .filter((c) => c.url.startsWith("https://api.github.com"))
        .map((c) => new URL(c.url).pathname),
    ).toEqual(["/user"]);
    expect(readdirSync(join(configDir, "github", ACCOUNT))).toEqual(["broker.json"]);
  });

  test("a login another user claimed after a rename is refused, by the id recorded at link", async () => {
    const configDir = await brokeredConfigDir();
    stubNetwork({
      keys: ["github_pat_recycled"],
      users: { github_pat_recycled: { login: "Maya-Reeves", id: 5202 } },
    });
    const context = await brokeredContext(configDir);
    await expect(context.client.listAccessibleRepos()).rejects.toMatchObject({
      reason: "identity-changed",
      kind: "auth",
    });
  });

  test("the linked user still syncs after renaming their login", async () => {
    const configDir = await brokeredConfigDir();
    stubNetwork({
      keys: ["github_pat_renamed"],
      users: { github_pat_renamed: { login: "maya-r", id: MAYA_ID } },
    });
    const context = await brokeredContext(configDir);
    await expect(context.client.listAccessibleRepos()).resolves.toEqual([]);
  });

  test("a binding linked before the user id was recorded fails closed until linked again", async () => {
    const configDir = await brokeredConfigDir({ accountLabel: "acme-org" });
    const calls = stubNetwork({ keys: ["github_pat_brokered"] });
    const context = await brokeredContext(configDir);
    await expect(context.client.listAccessibleRepos()).rejects.toMatchObject({
      reason: "identity-changed",
      kind: "auth",
    });
    expect(calls.filter((c) => c.url.startsWith("https://api.github.com"))).toEqual([]);
  });

  test("the spec's verify is the check createContext runs", async () => {
    const respond = vi.fn(() => Promise.resolve(Response.json({ login: "jamie-lopez", id: 5202 })));
    vi.stubGlobal("fetch", respond);
    const verify = definition.broker!.verify!(ACCOUNT, LINKED);
    await expect(
      verify("default", {
        credential: { type: "api-key", apiKey: "github_pat_swapped" },
        connectionConfig: {},
        metadata: {},
      }),
    ).rejects.toMatchObject({ reason: "identity-changed" });
  });

  test("a failed check keeps its own kind and is never taken as a match", async () => {
    const result = {
      credential: { type: "api-key" as const, apiKey: "github_pat_brokered" },
      connectionConfig: {},
      metadata: {},
    };
    const failing = (respond: () => Promise<Response>) =>
      verifyGithubIdentity(ACCOUNT, () => LINKED, {
        fetchImpl: respond as typeof fetch,
        sleep: async () => {},
      });

    await expect(
      failing(() => Promise.reject(new TypeError("fetch failed")))("default", result),
    ).rejects.toMatchObject({ kind: "network" });
    await expect(
      failing(() =>
        Promise.resolve(Response.json({ message: "Bad credentials" }, { status: 401 })),
      )("default", result),
    ).rejects.toMatchObject({ kind: "auth" });
    await expect(
      failing(() => Promise.resolve(new Response("unavailable", { status: 503 })))(
        "default",
        result,
      ),
    ).rejects.not.toMatchObject({ reason: "identity-changed" });

    // A verifier whose check failed asks again for the same token.
    let up = false;
    const fetchImpl = vi.fn(() =>
      up
        ? Promise.resolve(Response.json({ login: "maya-reeves", id: MAYA_ID }))
        : Promise.reject(new TypeError("fetch failed")),
    );
    const verify = verifyGithubIdentity(ACCOUNT, () => LINKED, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    await expect(verify("default", result)).rejects.toMatchObject({ kind: "network" });
    up = true;
    await expect(verify("default", result)).resolves.toBeUndefined();
    await expect(verify("default", result)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
