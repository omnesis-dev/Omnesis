// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, verify } from "node:crypto";
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
} from "@omnesis/core";
import { ProviderId } from "@omnesis/types";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { deriveAccountId } from "./provider.js";
import definition from "./index.js";
import type { KeyObject } from "node:crypto";
import type { CoinbaseContext } from "./types.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const BROKER = { kind: "nango" as const, url: "http://broker.test", secretKey: "broker-key" };
const REF = { providerConfigKey: "coinbase-cdp", connectionId: "maya-reeves-portfolio" };
const PORTFOLIO_ID = "11111111-2222-3333-4444-555555555555";

function cdpKey(name: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    keyId: `organizations/00000000-0000-0000-0000-000000000000/apiKeys/${name}`,
    pem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicKey,
  };
}

const KEY = cdpKey("maya-reeves-view");

async function brokeredConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-coinbase-broker-"));
  tmpDirs.push(dir);
  await writeCredentialBrokerConfig(BROKER, dir);
  await writeBrokerBinding(
    "coinbase",
    PORTFOLIO_ID,
    { broker: "nango", connections: { default: REF } },
    dir,
  );
  return dir;
}

interface Call {
  url: string;
  authorization: string | null;
}

/** The `kid` a Coinbase request's JWT names, verified against `publicKey` when given. */
function jwtKid(authorization: string | null, publicKey?: KeyObject) {
  const jwt = (authorization ?? "").replace(/^Bearer /, "");
  const [header, payload, signature] = jwt.split(".");
  if (publicKey) {
    const ok = verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature!, "base64url"),
    );
    if (!ok) throw new Error("JWT signature does not verify");
  }
  return (JSON.parse(Buffer.from(header!, "base64url").toString("utf8")) as { kid: string }).kid;
}

/**
 * Stub the network: the broker hands out `keys` in turn (a forced refresh
 * advances to the next), and Coinbase answers 401 to any key in `refused`.
 */
function stubNetwork(opts: {
  keys: Array<{ keyId: string; pem: string }>;
  refused?: string[];
  permissions?: Record<string, unknown>;
  accounts?: unknown[];
  brokerCredentials?: Record<string, unknown>;
}) {
  const calls: Call[] = [];
  let served = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization");
      calls.push({ url, authorization });
      if (url.startsWith(BROKER.url)) {
        // Each fetch sees what the broker holds by then: a rotation lands
        // between the first fetch and the next.
        const key = opts.keys[Math.min(served++, opts.keys.length - 1)]!;
        return Promise.resolve(
          Response.json({
            credentials: opts.brokerCredentials ?? {
              type: "BASIC",
              username: key.keyId,
              password: key.pem,
            },
          }),
        );
      }
      if (opts.refused?.includes(jwtKid(authorization))) {
        return Promise.resolve(Response.json({ error: "unauthorized" }, { status: 401 }));
      }
      if (url.includes("/key_permissions")) {
        return Promise.resolve(
          Response.json(
            opts.permissions ?? {
              can_view: true,
              can_trade: false,
              can_transfer: false,
              retail_portfolio_id: PORTFOLIO_ID,
            },
          ),
        );
      }
      return Promise.resolve(
        Response.json({ accounts: opts.accounts ?? [], has_next: false, size: 0 }),
      );
    }),
  );
  return {
    calls,
    broker: () => calls.filter((c) => c.url.startsWith(BROKER.url)),
    coinbase: () => calls.filter((c) => c.url.startsWith("https://api.coinbase.com")),
  };
}

async function brokeredContext(configDir: string): Promise<CoinbaseContext> {
  return definition.createContext!({
    accountId: PORTFOLIO_ID,
    providerId: ProviderId(`coinbase:${PORTFOLIO_ID}`),
    host: fakeProviderHost({ configDir }),
  });
}

function credentialsFor(): BrokeredCredentials {
  return new BrokeredCredentials({ broker: "nango", connections: { default: REF } }, BROKER);
}

describe("Coinbase with a brokered CDP key", () => {
  test("discovers the brokered portfolio with no key file on disk", async () => {
    const configDir = await brokeredConfigDir();
    expect(existsSync(join(configDir, "coinbase-credentials.json"))).toBe(false);
    await expect(definition.discover!({ configDir })).resolves.toEqual([PORTFOLIO_ID]);
  });

  test("discovers it beside a portfolio whose key was pasted", async () => {
    const configDir = await brokeredConfigDir();
    await writeProviderAccountCredentials(
      "coinbase",
      "pasted-portfolio",
      { key_id: "organizations/x/apiKeys/pasted", private_key: "fictional" },
      configDir,
    );
    const ids = await definition.discover!({ configDir });
    expect([...ids].sort()).toEqual([PORTFOLIO_ID, "pasted-portfolio"].sort());
  });

  test("signs every Coinbase request with the key the broker holds, and stores none", async () => {
    const configDir = await brokeredConfigDir();
    const net = stubNetwork({ keys: [KEY] });
    const context = await brokeredContext(configDir);
    await context.client.getAccounts(1);
    await context.client.getPortfolios().catch(() => undefined);

    expect(net.broker()[0]!.authorization).toBe("Bearer broker-key");
    expect(net.broker()).toHaveLength(1);
    expect(net.coinbase().length).toBe(2);
    for (const call of net.coinbase()) {
      expect(jwtKid(call.authorization, KEY.publicKey)).toBe(KEY.keyId);
    }
    expect(readdirSync(join(configDir, "coinbase", PORTFOLIO_ID))).toEqual(["broker.json"]);
    expect(existsSync(join(configDir, "coinbase-credentials.json"))).toBe(false);
  });

  test("signs with a private key whose newlines a single-line password field stripped", async () => {
    const configDir = await brokeredConfigDir();
    const flattened = { keyId: KEY.keyId, pem: KEY.pem.replace(/[\r\n]/g, "") };
    const net = stubNetwork({ keys: [flattened] });
    const context = await brokeredContext(configDir);
    await context.client.getAccounts(1);
    expect(jwtKid(net.coinbase()[0]!.authorization, KEY.publicKey)).toBe(KEY.keyId);
  });

  test("on a refused key, takes the one the broker now holds and repeats the request once", async () => {
    const configDir = await brokeredConfigDir();
    const rotated = cdpKey("maya-reeves-rotated");
    const net = stubNetwork({ keys: [KEY, rotated], refused: [KEY.keyId] });
    const context = await brokeredContext(configDir);
    await expect(context.client.getAccounts(1)).resolves.toMatchObject({ accounts: [] });

    // A key has no refresh at the broker, so the retry fetches it again as it stands.
    expect(net.broker().map((c) => new URL(c.url).searchParams.get("force_refresh"))).toEqual([
      null,
      null,
    ]);
    expect(net.coinbase().map((c) => jwtKid(c.authorization))).toEqual([KEY.keyId, rotated.keyId]);
  });

  test("does not repeat a refused request when the broker still holds the same key", async () => {
    const configDir = await brokeredConfigDir();
    const net = stubNetwork({ keys: [KEY], refused: [KEY.keyId] });
    const context = await brokeredContext(configDir);
    await expect(context.client.getAccounts(1)).rejects.toMatchObject({ kind: "auth" });
    expect(net.coinbase()).toHaveLength(1);
    expect(net.broker()).toHaveLength(2);
  });

  test("is connected while the binding reads, and never-connected once it is removed", async () => {
    const configDir = await brokeredConfigDir();
    const net = stubNetwork({ keys: [KEY] });
    const context = await brokeredContext(configDir);
    await expect(definition.credentialState!(context)).resolves.toEqual({ status: "connected" });
    await definition.cleanupCredentials!(PORTFOLIO_ID, { configDir });
    expect(existsSync(brokerBindingPath("coinbase", PORTFOLIO_ID, configDir))).toBe(false);
    await expect(definition.credentialState!(context)).resolves.toEqual({
      status: "never-connected",
    });
    expect(net.calls).toEqual([]);
  });

  test("removing it leaves the pre-per-account shared key and other portfolios alone", async () => {
    const configDir = await brokeredConfigDir();
    const net = stubNetwork({ keys: [KEY] });
    await writeProviderCredentials(
      "coinbase",
      { key_id: "organizations/x/apiKeys/legacy", private_key: "fictional" },
      configDir,
    );
    await definition.cleanupCredentials!(PORTFOLIO_ID, { configDir });
    expect(existsSync(join(configDir, "coinbase", PORTFOLIO_ID))).toBe(false);
    expect(existsSync(join(configDir, "coinbase-credentials.json"))).toBe(true);
    expect(net.calls).toEqual([]);
  });
});

describe("linking a brokered CDP key", () => {
  test("names the account after the portfolio the key reads, as a paste would", async () => {
    const net = stubNetwork({ keys: [KEY] });
    await expect(definition.broker!.resolveAccount(credentialsFor(), {})).resolves.toEqual({
      accountId: PORTFOLIO_ID,
    });
    expect(net.coinbase().map((c) => new URL(c.url).pathname)).toEqual([
      "/api/v3/brokerage/key_permissions",
      "/api/v3/brokerage/accounts",
    ]);
  });

  test("takes the portfolio from the accounts read when key_permissions omits it", async () => {
    stubNetwork({
      keys: [KEY],
      permissions: { can_view: true, can_trade: false, can_transfer: false },
      accounts: [{ uuid: "a1", currency: "BTC", retail_portfolio_id: PORTFOLIO_ID }],
    });
    await expect(definition.broker!.resolveAccount(credentialsFor(), {})).resolves.toEqual({
      accountId: PORTFOLIO_ID,
    });
  });

  test("falls back to the key-derived id the paste flow would store", async () => {
    stubNetwork({
      keys: [KEY],
      permissions: { can_view: true, can_trade: false, can_transfer: false },
    });
    await expect(definition.broker!.resolveAccount(credentialsFor(), {})).resolves.toEqual({
      accountId: String(deriveAccountId(undefined, KEY.keyId)),
    });
  });

  test("refuses a key that can trade, as a paste would", async () => {
    stubNetwork({
      keys: [KEY],
      permissions: { can_view: true, can_trade: true, can_transfer: false },
    });
    await expect(definition.broker!.resolveAccount(credentialsFor(), {})).rejects.toMatchObject({
      code: "credential-rejected",
    });
  });

  test("refuses a connection that holds a token instead of a key", async () => {
    stubNetwork({ keys: [KEY], brokerCredentials: { type: "API_KEY", apiKey: "fictional" } });
    await expect(definition.broker!.resolveAccount(credentialsFor(), {})).rejects.toMatchObject({
      name: "BrokerCredentialError",
      reason: "unsupported",
    });
  });
});
