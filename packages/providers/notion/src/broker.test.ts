// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrokeredCredentials,
  brokerBindingPath,
  writeBrokerBinding,
  writeCredentialBrokerConfig,
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
const REF = { providerConfigKey: "notion", connectionId: "conn-notion" };

async function brokeredConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-notion-broker-"));
  tmpDirs.push(dir);
  await writeCredentialBrokerConfig(BROKER, dir);
  await writeBrokerBinding(
    "notion",
    "workspace-9",
    { broker: "nango", connections: { default: REF } },
    dir,
  );
  return dir;
}

function stubNetwork(token: string) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.startsWith(BROKER.url)) {
        return Promise.resolve(
          Response.json({
            credentials: {
              type: "OAUTH2",
              access_token: token,
              raw: { workspace_id: "workspace-9", workspace_name: "Studio Northstar" },
            },
          }),
        );
      }
      return Promise.resolve(Response.json({ object: "list", results: [], has_more: false }));
    }),
  );
  return calls;
}

describe("Notion with a brokered grant", () => {
  test("discovers the brokered workspace with no token or client file on disk", async () => {
    const configDir = await brokeredConfigDir();
    expect(existsSync(join(configDir, "notion-credentials.json"))).toBe(false);
    await expect(definition.discover!({ configDir })).resolves.toEqual(["workspace-9"]);
  });

  test("calls Notion with the token the broker hands out", async () => {
    const configDir = await brokeredConfigDir();
    const calls = stubNetwork("brokered-notion-token");
    const context = await definition.createContext!({
      accountId: "workspace-9",
      providerId: ProviderId("notion:workspace-9"),
      host: fakeProviderHost({ configDir }),
    });
    await context.client.listUsers();

    const broker = calls.filter((c) => c.url.startsWith(BROKER.url));
    const notion = calls.filter((c) => c.url.startsWith("https://api.notion.com"));
    expect(broker[0]!.authorization).toBe("Bearer broker-key");
    expect(notion.length).toBeGreaterThan(0);
    for (const call of notion) expect(call.authorization).toBe("Bearer brokered-notion-token");
  });

  test("is connected while the binding reads, and never-connected once it is removed", async () => {
    const configDir = await brokeredConfigDir();
    stubNetwork("t");
    const context = await definition.createContext!({
      accountId: "workspace-9",
      providerId: ProviderId("notion:workspace-9"),
      host: fakeProviderHost({ configDir }),
    });
    await expect(definition.credentialState!(context)).resolves.toEqual({ status: "connected" });
    await definition.cleanupCredentials!("workspace-9", { configDir });
    expect(existsSync(brokerBindingPath("notion", "workspace-9", configDir))).toBe(false);
    await expect(definition.credentialState!(context)).resolves.toEqual({
      status: "never-connected",
    });
  });

  test("resolves the account to the workspace the token response names", async () => {
    stubNetwork("t");
    const credentials = new BrokeredCredentials(
      { broker: "nango", connections: { default: REF } },
      BROKER,
    );
    await expect(definition.broker!.resolveAccount(credentials, {})).resolves.toEqual({
      accountId: "workspace-9",
      params: { workspaceName: "Studio Northstar" },
    });
  });
});
