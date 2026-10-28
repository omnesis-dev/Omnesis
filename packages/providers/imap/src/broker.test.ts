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
} from "@omnesis/core";
import { ProviderId, SourceId } from "@omnesis/types";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { createImapClient } from "./client.js";
import definition from "./index.js";

interface BuiltOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}

const mocks = vi.hoisted(() => ({
  built: [] as BuiltOptions[],
  refused: [] as string[],
}));

vi.mock("imapflow", () => ({
  ImapFlow: class {
    usable = true;
    private readonly options: BuiltOptions;
    constructor(options: BuiltOptions) {
      this.options = options;
      mocks.built.push(options);
    }
    connect() {
      return mocks.refused.includes(this.options.auth.pass)
        ? Promise.reject(Object.assign(new Error("LOGIN failed"), { authenticationFailed: true }))
        : Promise.resolve();
    }
    logout() {
      return Promise.resolve();
    }
    close() {}
  },
}));

const tmpDirs: string[] = [];

beforeEach(() => {
  mocks.built.length = 0;
  mocks.refused.length = 0;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const BROKER = { kind: "nango" as const, url: "http://broker.test", secretKey: "broker-key" };
const REF = { providerConfigKey: "imap-logins", connectionId: "maya-reeves-mail" };
const ACCOUNT = "maya.reeves@example.com";

async function brokeredConfigDir(host = "imap.fastmail.com"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-imap-broker-"));
  tmpDirs.push(dir);
  await writeCredentialBrokerConfig(BROKER, dir);
  await writeBrokerBinding(
    "imap",
    ACCOUNT,
    { broker: "nango", connections: { default: REF }, params: { host } },
    dir,
  );
  return dir;
}

/**
 * Stub the broker: it hands out `passwords` in turn (a forced refresh
 * advances to the next) for `username`.
 */
function stubBroker(opts: {
  passwords: string[];
  username?: string;
  credentials?: Record<string, unknown>;
}) {
  const calls: Array<{ url: URL; authorization: string | null }> = [];
  let served = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      // Each fetch sees what the broker holds by then.
      const index = served++;
      return Promise.resolve(
        Response.json({
          credentials: opts.credentials ?? {
            type: "BASIC",
            username: opts.username ?? ACCOUNT,
            password: opts.passwords[Math.min(index, opts.passwords.length - 1)],
          },
        }),
      );
    }),
  );
  return calls;
}

async function brokeredContext(configDir: string) {
  return definition.createContext!({
    accountId: ACCOUNT,
    providerId: ProviderId(`imap:${ACCOUNT}`),
    host: fakeProviderHost({ configDir }),
  });
}

function credentialsFor(): BrokeredCredentials {
  return new BrokeredCredentials({ broker: "nango", connections: { default: REF } }, BROKER);
}

describe("IMAP with a brokered login", () => {
  test("discovers the brokered mailbox with no credential file on disk", async () => {
    const configDir = await brokeredConfigDir();
    await expect(definition.discover!({ configDir })).resolves.toEqual([
      { id: ACCOUNT, subject: { kind: "email", value: ACCOUNT } },
    ]);
  });

  test("logs in with the broker's password on the linked server, and stores none", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubBroker({ passwords: ["brokered-app-password"] });
    const context = await brokeredContext(configDir);
    expect(calls).toEqual([]);

    const client = createImapClient(context.credentials);
    await client.connect();
    await client.close();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.authorization).toBe("Bearer broker-key");
    expect(mocks.built).toEqual([
      expect.objectContaining({
        host: "imap.fastmail.com",
        port: 993,
        secure: true,
        auth: { user: ACCOUNT, pass: "brokered-app-password" },
      }),
    ]);
    expect(readdirSync(join(configDir, "imap", ACCOUNT))).toEqual(["broker.json"]);
  });

  test("the source takes its server from the link", async () => {
    const configDir = await brokeredConfigDir();
    stubBroker({ passwords: ["brokered-app-password"] });
    const context = await brokeredContext(configDir);
    const instance = await definition.sources[0]!.create!(
      {
        accountId: ACCOUNT,
        sourceId: SourceId(`imap:${ACCOUNT}`),
        providerId: ProviderId(`imap:${ACCOUNT}`),
      },
      context,
    );
    expect(instance.icon?.url).toBe("https://www.fastmail.com/apple-touch-icon.png");
    await instance.dispose?.();
  });

  test("on a refused password, logs in once more with the one the broker now holds", async () => {
    const configDir = await brokeredConfigDir();
    mocks.refused.push("old-app-password");
    const calls = stubBroker({ passwords: ["old-app-password", "new-app-password"] });
    const client = createImapClient((await brokeredContext(configDir)).credentials);
    await client.connect();

    // A login has no refresh at the broker, so the retry fetches it again as it stands.
    expect(calls.map((c) => c.url.searchParams.get("force_refresh"))).toEqual([null, null]);
    expect(mocks.built.map((o) => o.auth.pass)).toEqual(["old-app-password", "new-app-password"]);
  });

  test("does not repeat a refused password the broker still holds", async () => {
    const configDir = await brokeredConfigDir();
    mocks.refused.push("revoked-app-password");
    stubBroker({ passwords: ["revoked-app-password"] });
    const client = createImapClient((await brokeredContext(configDir)).credentials);
    await expect(client.connect()).rejects.toMatchObject({ kind: "auth" });
    expect(mocks.built).toHaveLength(1);
  });

  test("refuses a broker login that now names another mailbox", async () => {
    const configDir = await brokeredConfigDir();
    stubBroker({ passwords: ["fictional"], username: "jamie.ortiz@example.com" });
    const client = createImapClient((await brokeredContext(configDir)).credentials);
    await expect(client.connect()).rejects.toMatchObject({ kind: "auth" });
    expect(mocks.built).toEqual([]);
  });

  test("is connected while the binding reads, and never-connected once it is removed", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubBroker({ passwords: ["fictional"] });
    const context = await brokeredContext(configDir);
    await expect(definition.credentialState!(context)).resolves.toEqual({ status: "connected" });
    await definition.cleanupCredentials!(ACCOUNT, { configDir });
    expect(existsSync(brokerBindingPath("imap", ACCOUNT, configDir))).toBe(false);
    await expect(definition.credentialState!(context)).resolves.toEqual({
      status: "never-connected",
    });
    expect(calls).toEqual([]);
    expect(mocks.built).toEqual([]);
  });

  test("a link without a usable hostname is refused when the context is built", async () => {
    const configDir = await brokeredConfigDir("not a host");
    stubBroker({ passwords: ["fictional"] });
    await expect(brokeredContext(configDir)).rejects.toMatchObject({
      name: "BrokerCredentialError",
      kind: "auth",
    });
  });
});

describe("linking a brokered IMAP login", () => {
  test("names the account after the login, normalised as a paste is, once the server accepts it", async () => {
    stubBroker({ passwords: ["brokered-app-password"], username: "  Maya.Reeves@Example.com " });
    await expect(
      definition.broker!.resolveAccount(credentialsFor(), { host: "IMAP.Example.com" }),
    ).resolves.toEqual({ accountId: ACCOUNT, params: { host: "imap.example.com" } });
    expect(mocks.built).toEqual([
      expect.objectContaining({
        host: "imap.example.com",
        auth: { user: ACCOUNT, pass: "brokered-app-password" },
      }),
    ]);
  });

  test("declares the server as a required link parameter", () => {
    expect(definition.broker!.params).toEqual([
      expect.objectContaining({ name: "host", required: true }),
    ]);
  });

  test("refuses a login the server rejects", async () => {
    mocks.refused.push("wrong-app-password");
    stubBroker({ passwords: ["wrong-app-password"] });
    await expect(
      definition.broker!.resolveAccount(credentialsFor(), { host: "imap.example.com" }),
    ).rejects.toMatchObject({ code: "credential-rejected" });
  });

  test("refuses a login that is not an address, as a paste would", async () => {
    stubBroker({ passwords: ["fictional"], username: "maya" });
    await expect(
      definition.broker!.resolveAccount(credentialsFor(), { host: "imap.example.com" }),
    ).rejects.toThrow(/email address/);
    expect(mocks.built).toEqual([]);
  });

  test("refuses a connection that holds a token instead of a login", async () => {
    stubBroker({ passwords: [], credentials: { type: "API_KEY", apiKey: "fictional" } });
    await expect(
      definition.broker!.resolveAccount(credentialsFor(), { host: "imap.example.com" }),
    ).rejects.toMatchObject({ name: "BrokerCredentialError", reason: "unsupported" });
  });
});
