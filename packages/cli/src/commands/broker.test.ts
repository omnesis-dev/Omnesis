// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { listBrokeredAccountIds, readBrokerBinding } from "@omnesis/core";
import { keyFromFile, linkBrokeredAccount, parseConnectionArgs, parseParamArgs } from "./broker.js";
import type { ProviderBrokerSpec } from "@omnesis/source-sdk";

const created: string[] = [];
afterEach(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  created.length = 0;
});

const SINGLE: ProviderBrokerSpec = {
  fileKey: "example",
  purposes: [{ id: "default", label: "Example", brokerProviders: ["example"] }],
  async resolveAccount(credentials) {
    return { accountId: `acct-${await credentials.token()}` };
  },
};

const MULTI: ProviderBrokerSpec = {
  fileKey: "multi",
  purposes: [
    { id: "mail", label: "Mail", brokerProviders: ["mail"], required: false },
    { id: "files", label: "Files", brokerProviders: ["files"], required: false },
  ],
  params: [
    { name: "host", label: "Server", required: true },
    { name: "port", label: "Port", default: "993" },
  ],
  async resolveAccount(_credentials, params) {
    return { accountId: "maya.reeves@example.com", params: { resolved: params.host! } };
  },
};

describe("parseConnectionArgs", () => {
  test("a single-purpose provider takes a bare integration/connection", () => {
    expect(parseConnectionArgs(SINGLE, ["example/conn-1"])).toEqual({
      default: { providerConfigKey: "example", connectionId: "conn-1" },
    });
  });

  test("a multi-purpose provider needs each purpose named", () => {
    expect(parseConnectionArgs(MULTI, ["mail=m/1", "files=f/2"])).toEqual({
      mail: { providerConfigKey: "m", connectionId: "1" },
      files: { providerConfigKey: "f", connectionId: "2" },
    });
    expect(() => parseConnectionArgs(MULTI, ["m/1"])).toThrow(/Name what/);
    expect(() => parseConnectionArgs(MULTI, ["drive=d/1"])).toThrow(/Unknown purpose/);
    expect(() => parseConnectionArgs(MULTI, ["mail=m/1", "mail=m/2"])).toThrow(/twice/);
  });

  test("refuses malformed references, an empty list, and a missing required purpose", () => {
    expect(() => parseConnectionArgs(SINGLE, ["conn-1"])).toThrow(/integration/);
    expect(() => parseConnectionArgs(SINGLE, ["a/b/c"])).toThrow(/integration/);
    expect(() => parseConnectionArgs(MULTI, [])).toThrow(/at least one/);
    const required: ProviderBrokerSpec = {
      ...MULTI,
      purposes: [{ id: "mail", label: "Mail", brokerProviders: [] }, MULTI.purposes[1]!],
    };
    expect(() => parseConnectionArgs(required, ["files=f/2"])).toThrow(/must be linked/);
  });
});

describe("parseParamArgs", () => {
  test("applies defaults and refuses undeclared or missing required params", () => {
    expect(parseParamArgs(MULTI, ["host=imap.example.com"])).toEqual({
      host: "imap.example.com",
      port: "993",
    });
    expect(() => parseParamArgs(MULTI, [])).toThrow(/required/);
    expect(() => parseParamArgs(MULTI, ["host=x", "tls=no"])).toThrow(/Unknown parameter/);
    expect(() => parseParamArgs(SINGLE, ["x=y"])).toThrow(/takes none/);
  });
});

describe("keyFromFile", () => {
  test("reads a bare key, or the Nango entry of an env file", () => {
    expect(keyFromFile("k-123\n")).toBe("k-123");
    expect(keyFromFile("# Nango\nAGENT_HOST=https://h.example.com\nNANGO_SECRET_KEY=k-456\n")).toBe(
      "k-456",
    );
    expect(keyFromFile('export NANGO_SECRET_KEY="k-789"')).toBe("k-789");
    expect(keyFromFile("A=1\nOTHER_KEY=k-0", "OTHER_KEY")).toBe("k-0");
  });

  test("refuses a file it cannot read one key from", () => {
    expect(keyFromFile("")).toBeUndefined();
    expect(keyFromFile("a\nb")).toBeUndefined();
    expect(keyFromFile("AGENT_HOST=https://h.example.com")).toBeUndefined();
  });
});

describe("linkBrokeredAccount", () => {
  const config = { kind: "nango" as const, url: "http://127.0.0.1:3999", secretKey: "k" };
  const brokerFetch = (async () =>
    Response.json({ credentials: { type: "API_KEY", apiKey: "probe" } })) as typeof fetch;

  test("stores the binding under the account the provider resolves, with its params", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-broker-link-"));
    created.push(dir);
    const result = await linkBrokeredAccount({
      spec: MULTI,
      config,
      connections: { mail: { providerConfigKey: "m", connectionId: "1" } },
      params: { host: "imap.example.com" },
      configDir: dir,
      fetch: brokerFetch,
    });
    expect(result.accountId).toBe("maya.reeves@example.com");
    expect(result.replaced).toBe(false);
    expect(await readBrokerBinding("multi", "maya.reeves@example.com", dir)).toEqual({
      broker: "nango",
      connections: { mail: { providerConfigKey: "m", connectionId: "1" } },
      params: { host: "imap.example.com", resolved: "imap.example.com" },
    });
  });

  test("refuses to take over an account signed in here unless told to", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-broker-link-"));
    created.push(dir);
    mkdirSync(join(dir, "multi", "maya.reeves@example.com"), { recursive: true });
    writeFileSync(join(dir, "multi", "maya.reeves@example.com", "tokens.json"), "{}");
    const link = (replace?: boolean) =>
      linkBrokeredAccount({
        spec: MULTI,
        config,
        connections: { mail: { providerConfigKey: "m", connectionId: "1" } },
        params: { host: "imap.example.com" },
        configDir: dir,
        replace,
        fetch: brokerFetch,
      });
    await expect(link()).rejects.toThrow(/already signed in here/);
    expect(listBrokeredAccountIds("multi", dir)).toEqual([]);
    await expect(link(true)).resolves.toMatchObject({ replaced: true });
    expect(listBrokeredAccountIds("multi", dir)).toEqual(["maya.reeves@example.com"]);
  });

  test("writes nothing when the provider cannot resolve the account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-broker-link-"));
    created.push(dir);
    const failing: ProviderBrokerSpec = {
      ...SINGLE,
      async resolveAccount() {
        throw new Error("upstream refused the credential");
      },
    };
    await expect(
      linkBrokeredAccount({
        spec: failing,
        config,
        connections: { default: { providerConfigKey: "example", connectionId: "c" } },
        params: {},
        configDir: dir,
        fetch: brokerFetch,
      }),
    ).rejects.toThrow(/refused/);
    expect(listBrokeredAccountIds("example", dir)).toEqual([]);
  });
});
