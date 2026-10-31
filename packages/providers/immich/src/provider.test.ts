// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProviderAccountCredentials } from "@omnesis/core";
import { AuthFailure, type AuthSession } from "@omnesis/source-sdk";
import { fakeProviderHost } from "@omnesis/source-sdk/testing";
import { authenticate, cleanupCredentials, discoverAccounts, hasCredentials } from "./provider.js";
import { SimulatedImmich, type SimulatedImmichCorpus } from "./testing/simulated-immich.js";
import { buildImmichProvider } from "./index.js";

const BASE = "http://immich.example.com:2283";
const MAYA = { id: "u-maya", email: "Maya.Reeves@example.com", name: "Maya Reeves" };
const DAVID = { id: "u-david", email: "david.lin@example.com", name: "David Lin", isAdmin: true };
const READ = ["asset.read", "album.read", "user.read"];

function server(over: Partial<SimulatedImmichCorpus> = {}) {
  return new SimulatedImmich({
    users: [MAYA, DAVID],
    keys: [
      { key: "maya-key", userId: MAYA.id, permissions: READ },
      { key: "david-key", userId: DAVID.id, permissions: ["all"] },
      { key: "narrow-key", userId: MAYA.id, permissions: ["asset.read"] },
    ],
    assets: [],
    ...over,
  });
}

let configDir: string;
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "omnesis-immich-provider-"));
});
afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

function session(answer: Record<string, string>, overrides: Partial<AuthSession> = {}) {
  const asked: Array<{ title: string; prefill?: Record<string, string> }> = [];
  const s: AuthSession = {
    reason: overrides.accountId ? "reauthenticate" : "connect",
    flowId: "flow-1",
    supplied: {},
    host: { ...fakeProviderHost(), configDir },
    canShow: () => true,
    show: () => {},
    ask: (c) => {
      asked.push({
        title: c.title,
        ...(c.kind === "fields" && c.prefill ? { prefill: c.prefill } : {}),
      });
      return Promise.resolve(answer as never);
    },
    ...overrides,
  };
  return { session: s, asked };
}

describe("authenticate", () => {
  it("probes the key, then stores the normalized address and key under the user's email", async () => {
    const sim = server();
    const { session: s } = session({ base_url: `${BASE}/api/`, api_key: " maya-key " });
    const result = await authenticate(s, { fetchImpl: sim.fetch });

    expect(result.accounts).toEqual([
      { accountId: "maya.reeves@example.com", state: { status: "connected" } },
    ]);
    expect(result.notices).toBeUndefined();
    expect(
      await readProviderAccountCredentials("immich", "maya.reeves@example.com", configDir),
    ).toEqual({
      base_url: BASE,
      api_key: "maya-key",
      user_id: MAYA.id,
    });
    expect(discoverAccounts(configDir).map(String)).toEqual(["maya.reeves@example.com"]);
  });

  it("warns, without refusing, about an administrator's all-powerful key", async () => {
    const { session: s } = session({ base_url: BASE, api_key: "david-key" });
    const result = await authenticate(s, { fetchImpl: server().fetch });
    expect(result.accounts[0]!.accountId).toBe("david.lin@example.com");
    expect(result.notices?.[0]?.detail).toMatch(/administrator and is granted every permission/);
  });

  it("refuses a key missing a required permission, and stores nothing", async () => {
    const { session: s } = session({ base_url: BASE, api_key: "narrow-key" });
    const err = await authenticate(s, { fetchImpl: server().fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFailure);
    expect(err).toMatchObject({ code: "credential-rejected" });
    expect((err as Error).message).toContain("album.read, user.read");
    expect(hasCredentials("maya.reeves@example.com", configDir)).toBe(false);
  });

  it("refuses an unknown key and a server older than v3", async () => {
    await expect(
      authenticate(session({ base_url: BASE, api_key: "nope" }).session, {
        fetchImpl: server().fetch,
      }),
    ).rejects.toMatchObject({ code: "credential-rejected" });
    const old = server({ version: { major: 2, minor: 4, patch: 1 } });
    await expect(
      authenticate(session({ base_url: BASE, api_key: "maya-key" }).session, {
        fetchImpl: old.fetch,
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("reports an unreachable server as unavailable and a bad address as rejected", async () => {
    const down: typeof fetch = () => Promise.reject(new TypeError("connect ECONNREFUSED"));
    await expect(
      authenticate(session({ base_url: BASE, api_key: "maya-key" }).session, { fetchImpl: down }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      authenticate(session({ base_url: "immich.local", api_key: "maya-key" }).session, {
        fetchImpl: server().fetch,
      }),
    ).rejects.toMatchObject({ code: "credential-rejected" });
  });

  it("on renewal, prefills the stored address and refuses another user's key", async () => {
    const sim = server();
    await authenticate(session({ base_url: BASE, api_key: "maya-key" }).session, {
      fetchImpl: sim.fetch,
    });

    const renewal = session(
      { base_url: BASE, api_key: "david-key" },
      { accountId: "maya.reeves@example.com" },
    );
    await expect(authenticate(renewal.session, { fetchImpl: sim.fetch })).rejects.toMatchObject({
      code: "identity-mismatch",
    });
    expect(renewal.asked[0]!.prefill).toEqual({ base_url: BASE });
    expect(
      await readProviderAccountCredentials("immich", "maya.reeves@example.com", configDir),
    ).toEqual({
      base_url: BASE,
      api_key: "maya-key",
      user_id: MAYA.id,
    });
  });

  it("refuses a second server whose user has the same email, leaving the first account intact", async () => {
    await authenticate(session({ base_url: BASE, api_key: "maya-key" }).session, {
      fetchImpl: server().fetch,
    });
    // Another server: a different user id behind the same email.
    const other = new SimulatedImmich({
      users: [{ ...MAYA, id: "u-maya-on-family-server" }],
      keys: [{ key: "family-key", userId: "u-maya-on-family-server", permissions: READ }],
      assets: [],
    });
    for (const reauth of [undefined, "maya.reeves@example.com"]) {
      const s = session(
        { base_url: "http://family.example.org", api_key: "family-key" },
        reauth ? { accountId: reauth } : {},
      ).session;
      await expect(authenticate(s, { fetchImpl: other.fetch })).rejects.toMatchObject({
        code: "identity-mismatch",
      });
    }
    expect(
      await readProviderAccountCredentials("immich", "maya.reeves@example.com", configDir),
    ).toEqual({
      base_url: BASE,
      api_key: "maya-key",
      user_id: MAYA.id,
    });
  });

  it("lets a renewal point at a server that moved, keeping the same user", async () => {
    const sim = server();
    await authenticate(session({ base_url: BASE, api_key: "maya-key" }).session, {
      fetchImpl: sim.fetch,
    });
    const moved = session(
      { base_url: "https://photos.example.org", api_key: "maya-key" },
      { accountId: "maya.reeves@example.com" },
    );
    await authenticate(moved.session, { fetchImpl: sim.fetch });
    expect(
      (await readProviderAccountCredentials("immich", "maya.reeves@example.com", configDir))
        ?.base_url,
    ).toBe("https://photos.example.org");
  });

  it("names an address that does not serve the Immich API", async () => {
    const html: typeof fetch = () =>
      Promise.resolve(new Response("<html>router login</html>", { status: 200 }));
    const err = await authenticate(session({ base_url: BASE, api_key: "maya-key" }).session, {
      fetchImpl: html,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "credential-rejected" });
    expect((err as Error).message).toContain("does not serve the Immich API");
  });

  it("refuses an empty key as a rejected credential", async () => {
    await expect(
      authenticate(session({ base_url: BASE, api_key: "  " }).session, {
        fetchImpl: server().fetch,
      }),
    ).rejects.toMatchObject({ code: "credential-rejected" });
  });

  it("takes fields an older client already collected without asking again", async () => {
    const { session: s, asked } = session(
      {},
      { supplied: { base_url: BASE, api_key: "maya-key" } },
    );
    await authenticate(s, { fetchImpl: server().fetch });
    expect(asked).toEqual([]);
  });
});

describe("provider lifecycle", () => {
  it("keeps two accounts apart and cleans up one without touching the other", async () => {
    const sim = server();
    await authenticate(session({ base_url: BASE, api_key: "maya-key" }).session, {
      fetchImpl: sim.fetch,
    });
    await authenticate(session({ base_url: BASE, api_key: "david-key" }).session, {
      fetchImpl: sim.fetch,
    });
    expect(discoverAccounts(configDir).map(String).sort()).toEqual([
      "david.lin@example.com",
      "maya.reeves@example.com",
    ]);

    await cleanupCredentials("david.lin@example.com", configDir);
    expect(discoverAccounts(configDir).map(String)).toEqual(["maya.reeves@example.com"]);
  });

  it("refuses a link address that cannot be linked to, naming the setting", async () => {
    const provider = buildImmichProvider({ fetchImpl: server().fetch });
    await authenticate(session({ base_url: BASE, api_key: "maya-key" }).session, {
      fetchImpl: server().fetch,
    });
    const host = { ...fakeProviderHost(), configDir, stateDir: configDir };
    const ctx = await provider.createContext!({
      accountId: "maya.reeves@example.com",
      host,
    } as never);
    const create = (linkAddress: string) =>
      Promise.resolve().then(() =>
        provider.sources[0]!.create!(
          {
            sourceId: "immich:maya.reeves@example.com",
            providerId: "immich:maya.reeves@example.com",
            config: { pageSize: 250, linkAddress },
            host,
          } as never,
          ctx,
        ),
      );
    await expect(create("https://photos.example.org/?share=1")).rejects.toThrow(
      /Address for links/,
    );
    await expect(create("https://photos.example.org/")).resolves.toBeDefined();
  });

  it("answers credential state offline from the stored key", async () => {
    const provider = buildImmichProvider({
      fetchImpl: () => Promise.reject(new Error("credentialState must not touch the network")),
    });
    expect(
      await provider.credentialState!({ accountId: "maya.reeves@example.com", configDir } as never),
    ).toMatchObject({ status: "never-connected" });

    await authenticate(session({ base_url: BASE, api_key: "maya-key" }).session, {
      fetchImpl: server().fetch,
    });
    expect(
      await provider.credentialState!({ accountId: "maya.reeves@example.com", configDir } as never),
    ).toMatchObject({ status: "connected" });
  });
});
