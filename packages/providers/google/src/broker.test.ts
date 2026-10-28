// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { google } from "googleapis";
import {
  BrokeredCredentials,
  brokerBindingPath,
  createLogger,
  writeBrokerBinding,
  writeCredentialBrokerConfig,
  type BrokerBinding,
} from "@omnesis/core";
import { ProviderId, SourceId } from "@omnesis/types";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeProviderHost, fakeSourceHost } from "@omnesis/source-sdk/testing";
import definition from "./index.js";
import type { AuthSession } from "@omnesis/source-sdk";

const tmpDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  google.options({ fetchImplementation: undefined });
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const BROKER = { kind: "nango" as const, url: "http://broker.test", secretKey: "broker-key" };
const ACCOUNT = "maya.reeves@example.com";
const REFS = {
  gmail: { providerConfigKey: "google-mail", connectionId: "conn-mail" },
  calendar: { providerConfigKey: "google-calendar", connectionId: "conn-calendar" },
  drive: { providerConfigKey: "google-drive", connectionId: "conn-drive" },
  contacts: { providerConfigKey: "google-contacts", connectionId: "conn-contacts" },
};

type Purpose = keyof typeof REFS;

function binding(...purposes: Purpose[]): BrokerBinding {
  return {
    broker: "nango",
    connections: Object.fromEntries(purposes.map((p) => [p, REFS[p]])),
  };
}

async function brokeredConfigDir(...purposes: Purpose[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-google-broker-"));
  tmpDirs.push(dir);
  await writeCredentialBrokerConfig(BROKER, dir);
  await writeBrokerBinding("google", ACCOUNT, binding(...purposes), dir);
  return dir;
}

interface Call {
  url: URL;
  authorization: string | null;
}

/** What Google answers for a request, by path. Anything unnamed is an empty object. */
function defaultGoogle(url: URL): unknown {
  switch (`${url.host}${url.pathname}`) {
    case "gmail.googleapis.com/gmail/v1/users/me/profile":
      return { emailAddress: ACCOUNT, historyId: "4001" };
    case "gmail.googleapis.com/gmail/v1/users/me/messages":
      return { messages: [], resultSizeEstimate: 0 };
    case "www.googleapis.com/drive/v3/about":
      return { user: { emailAddress: ACCOUNT } };
    case "www.googleapis.com/calendar/v3/calendars/primary":
      return { id: ACCOUNT };
    case "people.googleapis.com/v1/people/me":
      return { resourceName: "people/104", etag: "etag-1" };
    case "people.googleapis.com/v1/people/me/connections":
      return { connections: [], nextSyncToken: "sync-1" };
    default:
      return {};
  }
}

/**
 * The broker and Google, both answered here.
 *
 * The broker is reached through the global `fetch`; googleapis requests go
 * through gaxios, which reaches for `node-fetch` in Node unless handed a
 * `fetchImplementation`, so the same handler is installed in both places.
 * The broker hands out `<connectionId>-token-<n>` for its n-th answer on a
 * connection, valid for an hour unless `expiresInMs` says otherwise.
 */
function stubNetwork(
  opts: {
    google?: (url: URL) => unknown;
    expiresInMs?: (connectionId: string, n: number) => number;
  } = {},
) {
  const calls: Call[] = [];
  const answered = new Map<string, number>();
  const answer = (url: URL): Response => {
    if (url.origin === BROKER.url) {
      const connectionId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const n = (answered.get(connectionId) ?? 0) + 1;
      answered.set(connectionId, n);
      const expiresIn = opts.expiresInMs?.(connectionId, n) ?? 60 * 60 * 1000;
      return Response.json({
        credentials: {
          type: "OAUTH2",
          access_token: `${connectionId}-token-${n}`,
          expires_at: new Date(Date.now() + expiresIn).toISOString(),
          raw: {},
        },
        connection_config: {},
        metadata: {},
      });
    }
    const body = (opts.google ?? defaultGoogle)(url);
    return body instanceof Response ? body : Response.json(body);
  };
  const handler = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    return Promise.resolve(answer(url));
  };
  vi.stubGlobal("fetch", vi.fn(handler));
  google.options({ fetchImplementation: handler as never });
  return {
    broker: () => calls.filter((c) => c.url.origin === BROKER.url),
    google: (host: string) => calls.filter((c) => c.url.host === host),
    all: calls,
  };
}

async function brokeredContext(configDir: string) {
  return definition.createContext!({
    accountId: ACCOUNT,
    providerId: ProviderId(`google:${ACCOUNT}`),
    host: fakeProviderHost({ configDir }),
  });
}

function sourceEntry(id: string) {
  const entry = definition.sources.find((s) => s.id === id);
  if (!entry?.create) throw new Error(`no source ${id}`);
  return entry.create;
}

function createSource(
  id: string,
  configDir: string,
  context: Awaited<ReturnType<typeof brokeredContext>>,
) {
  return sourceEntry(id)(
    {
      accountId: ACCOUNT,
      sourceId: SourceId(`${id}:${ACCOUNT}`),
      providerId: ProviderId(`google:${ACCOUNT}`),
      host: fakeSourceHost({ configDir }),
    },
    context,
  );
}

/** Every file under the account's directory. */
function accountFiles(configDir: string): string[] {
  return readdirSync(join(configDir, "google", ACCOUNT));
}

describe("Google with brokered grants", () => {
  test("discovers a brokered account beside a signed-in one, with no client or token file for it", async () => {
    const configDir = await brokeredConfigDir("gmail");
    await mkdir(join(configDir, "google", "olu.bassey@example.com"), { recursive: true });
    await writeFile(join(configDir, "google", "olu.bassey@example.com", "tokens.json"), "{}");

    expect(existsSync(join(configDir, "google-credentials.json"))).toBe(false);
    expect(accountFiles(configDir)).toEqual(["broker.json"]);
    const found = await definition.discover!({ configDir });
    expect(found).toHaveLength(2);
    expect(found).toEqual(
      expect.arrayContaining([
        { id: ACCOUNT, subject: { kind: "email", value: ACCOUNT } },
        {
          id: "olu.bassey@example.com",
          subject: { kind: "email", value: "olu.bassey@example.com" },
        },
      ]),
    );
  });

  test("each source calls Google with its own connection's token", async () => {
    const configDir = await brokeredConfigDir("gmail", "contacts");
    const net = stubNetwork();
    // No OAuth client file exists, so reaching for one would fail here.
    const context = await brokeredContext(configDir);

    const gmail = await createSource("gmail", configDir, context);
    const contacts = await createSource("google-contacts", configDir, context);
    await gmail.sync(null);
    await contacts.sync(null);

    const mail = net.google("gmail.googleapis.com");
    const people = net.google("people.googleapis.com");
    expect(mail.length).toBeGreaterThan(0);
    expect(people.length).toBeGreaterThan(0);
    for (const call of mail) expect(call.authorization).toBe("Bearer conn-mail-token-1");
    for (const call of people) expect(call.authorization).toBe("Bearer conn-contacts-token-1");
    for (const call of net.broker()) expect(call.authorization).toBe("Bearer broker-key");
    expect(
      net
        .broker()
        .map((c) => c.url.searchParams.get("provider_config_key"))
        .sort(),
    ).toEqual(["google-contacts", "google-mail"]);
    expect(accountFiles(configDir)).toEqual(["broker.json"]);
  });

  test("a source whose purpose is not linked fails as an auth failure that names it", async () => {
    const configDir = await brokeredConfigDir("gmail");
    stubNetwork();
    const context = await brokeredContext(configDir);

    await expect(createSource("google-drive", configDir, context)).rejects.toMatchObject({
      name: "BrokerCredentialError",
      reason: "unbound",
      kind: "auth",
      message: expect.stringContaining("Google Drive"),
    });
    await expect(createSource("google-calendar", configDir, context)).rejects.toMatchObject({
      reason: "unbound",
      kind: "auth",
    });
    await expect(createSource("gmail", configDir, context)).resolves.toBeDefined();
  });

  test("a token falling due is renewed by the broker, never by Google, and nothing is written", async () => {
    const configDir = await brokeredConfigDir("gmail");
    // The first token is already inside the five-minute refresh window.
    const net = stubNetwork({ expiresInMs: (_id, n) => (n === 1 ? 60 * 1000 : 60 * 60 * 1000) });
    const googleRefresh = vi.spyOn(
      google.auth.OAuth2.prototype as unknown as { refreshToken: () => Promise<unknown> },
      "refreshToken",
    );
    const context = await brokeredContext(configDir);
    const api = google.gmail({ version: "v1", auth: context.provider.getAuth("gmail") });

    for (let i = 0; i < 3; i++) await api.users.getProfile({ userId: "me" });

    expect(net.google("gmail.googleapis.com").map((c) => c.authorization)).toEqual([
      "Bearer conn-mail-token-1",
      "Bearer conn-mail-token-2",
      "Bearer conn-mail-token-2",
    ]);
    expect(net.broker()).toHaveLength(2);
    expect(googleRefresh).not.toHaveBeenCalled();
    expect(accountFiles(configDir)).toEqual(["broker.json"]);
  });

  test("is connected while the binding reads, and never-connected once it is removed", async () => {
    const configDir = await brokeredConfigDir("calendar");
    const net = stubNetwork();
    const context = await brokeredContext(configDir);

    await expect(definition.credentialState!(context)).resolves.toEqual({ status: "connected" });
    expect(net.all).toHaveLength(0);
    await definition.cleanupCredentials!(ACCOUNT, { configDir });
    expect(existsSync(brokerBindingPath("google", ACCOUNT, configDir))).toBe(false);
    await expect(definition.credentialState!(context)).resolves.toEqual({
      status: "never-connected",
    });
  });

  test("disconnecting or removing the account never revokes the grant the broker holds", async () => {
    const configDir = await brokeredConfigDir("gmail", "drive");
    const net = stubNetwork();
    const revokeCredentials = vi.spyOn(google.auth.OAuth2.prototype, "revokeCredentials");
    const revokeToken = vi.spyOn(google.auth.OAuth2.prototype, "revokeToken");
    const context = await brokeredContext(configDir);
    await google
      .gmail({ version: "v1", auth: context.provider.getAuth("gmail") })
      .users.getProfile({ userId: "me" });

    await context.provider.disconnect();
    await definition.disposeContext!(context);
    await definition.cleanupCredentials!(ACCOUNT, { configDir });

    expect(revokeCredentials).not.toHaveBeenCalled();
    expect(revokeToken).not.toHaveBeenCalled();
    expect(net.all.filter((c) => c.url.pathname.includes("revoke"))).toHaveLength(0);
    expect(existsSync(join(configDir, "google", ACCOUNT))).toBe(false);
  });

  test("a brokered account is not signed in again here, so no token is written beside its binding", async () => {
    const configDir = await brokeredConfigDir("gmail");
    const session: AuthSession = {
      reason: "reauthenticate",
      flowId: "flow-1",
      accountId: ACCOUNT,
      supplied: {},
      host: {
        log: createLogger("test:google-broker"),
        now: () => new Date(),
        stateDir: join(configDir, "google"),
        configDir,
      },
      canShow: () => true,
      show: () => {},
      ask: (() => new Promise<never>(() => {})) as AuthSession["ask"],
    };

    await expect(definition.authenticate!(session)).rejects.toMatchObject({
      name: "AuthFailure",
      code: "unsupported",
    });
    expect(accountFiles(configDir)).toEqual(["broker.json"]);
  });
});

describe("Google broker account resolution", () => {
  const resolve = (purposes: Purpose[], params: Record<string, string> = {}) =>
    definition.broker!.resolveAccount(
      new BrokeredCredentials(binding(...purposes), BROKER),
      params,
    );

  test("names the account by the address Gmail reports, asking each purpose with its own token", async () => {
    const net = stubNetwork();
    await expect(resolve(["gmail", "calendar", "drive", "contacts"])).resolves.toEqual({
      accountId: ACCOUNT,
    });
    expect(net.google("gmail.googleapis.com")[0]!.authorization).toBe("Bearer conn-mail-token-1");
    const www = net.google("www.googleapis.com");
    expect(www.find((c) => c.url.pathname.startsWith("/drive/"))!.authorization).toBe(
      "Bearer conn-drive-token-1",
    );
    expect(www.find((c) => c.url.pathname.startsWith("/calendar/"))!.authorization).toBe(
      "Bearer conn-calendar-token-1",
    );
    expect(net.google("people.googleapis.com")[0]!.authorization).toBe(
      "Bearer conn-contacts-token-1",
    );
  });

  test("refuses connections that belong to two different Google accounts", async () => {
    stubNetwork({
      google: (url) =>
        url.pathname === "/drive/v3/about"
          ? { user: { emailAddress: "olu.bassey@example.com" } }
          : defaultGoogle(url),
    });
    await expect(resolve(["gmail", "drive"])).rejects.toThrow(
      /Gmail connection belongs to maya\.reeves@example\.com, but Google Drive is olu\.bassey@example\.com/,
    );
  });

  test("takes the operator's address only when no linked purpose can name the account", async () => {
    stubNetwork();
    await expect(resolve(["contacts"])).rejects.toThrow(/give the account's email address/);
    await expect(resolve(["contacts"], { account: " Maya.Reeves@Example.com " })).resolves.toEqual({
      accountId: ACCOUNT,
    });
    await expect(resolve(["contacts"], { account: "maya" })).rejects.toThrow(
      /not an email address/,
    );
  });

  test("Contacts vouches for the account only with an address Google attributes to it", async () => {
    stubNetwork({
      google: (url) =>
        url.pathname === "/v1/people/me"
          ? {
              resourceName: "people/104",
              emailAddresses: [
                { value: "maya@studio.example.com", metadata: { source: { type: "PROFILE" } } },
                { value: ACCOUNT, metadata: { primary: true, source: { type: "ACCOUNT" } } },
              ],
            }
          : defaultGoogle(url),
    });
    await expect(resolve(["contacts"])).resolves.toEqual({ accountId: ACCOUNT });
    await expect(resolve(["contacts"], { account: "maya@studio.example.com" })).rejects.toThrow(
      /link connections of one Google account/,
    );
  });

  test("refuses an operator address that contradicts what Google reports", async () => {
    stubNetwork();
    await expect(resolve(["gmail"], { account: "olu.bassey@example.com" })).rejects.toThrow(
      /the account given is olu\.bassey@example\.com/,
    );
    await expect(resolve(["gmail"], { account: "MAYA.REEVES@example.com" })).resolves.toEqual({
      accountId: ACCOUNT,
    });
  });

  test("a probe Google refuses is reported against the connection it was made with", async () => {
    stubNetwork({
      google: (url) =>
        url.pathname === "/gmail/v1/users/me/profile"
          ? Response.json(
              { error: { code: 403, message: "Insufficient Permission" } },
              { status: 403 },
            )
          : defaultGoogle(url),
    });
    await expect(resolve(["gmail"])).rejects.toThrow(
      /which account the Gmail connection belongs to: .*Insufficient Permission/,
    );
  });
});
