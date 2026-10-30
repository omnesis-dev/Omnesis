// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderId, SourceId, SyncError } from "@omnesis/types";
import { fakeProviderHost, fakeSourceHost } from "@omnesis/source-sdk/testing";
import {
  OMNESIS_INSTALL_ROOT_KEY,
  clearSecretFileKeyCacheForTests,
  createSecretStore,
  ensureInstallRootKey,
  providerAccountCredentialsPath,
} from "@omnesis/core";
import { telegramCredentialsSpec } from "./credentials-spec.js";
import { readSessionRecord, writeSessionRecord } from "./session-store.js";
import { TelegramError } from "./client/types.js";
import { SimulatedTelegram } from "./testing/simulated-telegram.js";
import {
  DAVID,
  JAMIE,
  OTHER_ACCOUNT,
  SELF,
  T0,
  messageRun,
  privateChatWith,
  scriptedSession,
  tempConfigDir,
  until,
  writeAppCredentials,
} from "./testing/fixtures.js";
import telegram, { TELEGRAM_SOURCE_ID, buildTelegramProvider } from "./index.js";
import type { TelegramProvider } from "./provider.js";
import type { SourceInstance } from "@omnesis/source-sdk";

describe("the Telegram descriptor", () => {
  const source = telegram.sources[0]!;

  it("is one experimental, exclusive provider with the operator's own app credential", () => {
    expect(telegram.type).toBe("provider");
    expect(telegram.provider).toEqual({ id: "telegram", name: "Telegram" });
    expect(telegram.experimental).toBe(true);
    expect(telegram.multiDevice).toEqual({ mode: "exclusive" });
    expect(telegram.authType).toBe("qr");
    expect(telegram.credentials).toBe(telegramCredentialsSpec);
    expect(telegram.sources.map((s) => s.id)).toEqual([TELEGRAM_SOURCE_ID]);
    expect(source.experimental).toBeUndefined();
    expect(source.contentRetention).toBe("complete");
    expect(source.conversational).toBe(true);
  });

  it("draws a complete, generic icon", () => {
    expect(source.icon).toMatchObject({
      sfSymbol: "paperplane.fill",
      color: expect.stringMatching(/^#[0-9A-F]{6}$/u),
      bgColor: expect.stringMatching(/^#[0-9A-F]{6}$/u),
    });
    expect(source.icon?.url).toBeUndefined();
    const svg = Buffer.from(
      source.icon!.imageDataUri!.replace("data:image/svg+xml;base64,", ""),
      "base64",
    ).toString();
    expect(svg).toMatch(/^<svg /u);
    expect(svg).not.toMatch(/circle/u);
  });

  it("declares the self-identity alias the normalizer will emit", () => {
    expect(source.selfIdentity).toEqual({ aliasPrefix: "telegram-user", accountPattern: "^\\d+$" });
    expect(new RegExp(source.selfIdentity!.accountPattern!, "u").test(String(SELF.id))).toBe(true);
    expect(source.contract?.state?.version).toBe(1);
  });
});

describe("the Telegram provider lifecycle", () => {
  let configDir: string;
  let sim: SimulatedTelegram;
  let definition: ReturnType<typeof buildTelegramProvider>;
  const contexts: TelegramProvider[] = [];

  beforeEach(async () => {
    configDir = tempConfigDir("descriptor");
    await writeAppCredentials(configDir);
    sim = new SimulatedTelegram({ self: SELF });
    sim.addAccount({ self: OTHER_ACCOUNT });
    definition = buildTelegramProvider(() => Promise.resolve(sim.factory));
  });

  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await definition.disposeContext!(ctx);
    rmSync(configDir, { recursive: true, force: true });
  });

  async function seed(user: typeof SELF): Promise<void> {
    await writeSessionRecord(
      {
        session: sim.issueSession(user.id),
        userId: String(user.id),
        apiId: "1234567",
        connectedAt: "2026-03-10T09:00:00.000Z",
        ...(user.phone ? { phone: user.phone } : {}),
        ...(user.username ? { username: user.username } : {}),
      },
      configDir,
    );
  }

  async function context(accountId: string): Promise<TelegramProvider> {
    const stateDir = join(configDir, "telegram", accountId);
    const ctx = await definition.createContext!({
      accountId,
      providerId: ProviderId(`telegram:${accountId}`),
      host: fakeProviderHost({ configDir, stateDir }),
    });
    contexts.push(ctx);
    await ctx.ready();
    return ctx;
  }

  async function instance(accountId: string, ctx: TelegramProvider): Promise<SourceInstance> {
    const stateDir = join(configDir, "telegram", accountId);
    return definition.sources[0]!.create!(
      {
        accountId,
        sourceId: SourceId(`telegram-messages:${accountId}`),
        providerId: ProviderId(`telegram:${accountId}`),
        host: fakeSourceHost({ configDir, stateDir }),
        config: { includeChannels: false, excludedChats: [] },
      } as never,
      ctx,
    );
  }

  it("discovers accounts from their credential records only, described offline", async () => {
    await seed(SELF);
    await seed({ ...OTHER_ACCOUNT, phone: undefined, username: undefined });
    // A directory the host created is not an account.
    mkdirSync(join(configDir, "telegram", "5550100199"), { recursive: true });
    const accounts = await definition.discover!({ configDir });
    expect(accounts).toEqual(
      expect.arrayContaining([
        {
          id: String(SELF.id),
          label: "@maya_example",
          subject: { kind: "phone", value: "+12025550101" },
          aliases: [{ kind: "handle", value: "maya_example" }],
        },
        {
          id: String(OTHER_ACCOUNT.id),
          subject: { kind: "opaque", value: String(OTHER_ACCOUNT.id) },
          aliases: [],
        },
      ]),
    );
    expect(accounts).toHaveLength(2);
    expect(sim.calls).toEqual([]);
  });

  it("connects an account through authenticate", async () => {
    const { session } = scriptedSession(configDir);
    const flow = definition.authenticate!(session);
    await until(() => sim.calls.some((c) => c.method === "signInQr"));
    sim.qr.scan(SELF.id);
    await expect(flow).resolves.toMatchObject({ accounts: [{ accountId: String(SELF.id) }] });
    await expect(definition.discover!({ configDir })).resolves.toHaveLength(1);
  });

  it("syncs an account with no chats to one settled, empty page of its own archive", async () => {
    await seed(SELF);
    const ctx = await context(String(SELF.id));
    const source = await instance(String(SELF.id), ctx);
    const first = await source.sync(null);
    expect(first).toMatchObject({
      documents: [],
      deletedExternalIds: [],
      hasMore: false,
      cursor: { phase: "incremental", storeId: ctx.storeId },
      progress: { coverage: "complete", coverageSubject: "history" },
    });
    expect(sim.calls.map((c) => c.method)).toContain("iterDialogs");
    await expect(
      source.probeLocalStores!({ signal: new AbortController().signal }),
    ).resolves.toEqual([
      { keyName: "telegram-store", label: "Telegram message archive", state: "plaintext" },
      { keyName: "telegram-store", label: "Telegram connection cache", state: "absent" },
    ]);
  });

  it("parks a revoked account: sync fails as auth and credentialState reads unlinked", async () => {
    await seed(SELF);
    const ctx = await context(String(SELF.id));
    const source = await instance(String(SELF.id), ctx);
    const errors: string[] = [];
    source.onSourceError!((e) => errors.push(e));
    sim.revoke("SESSION_REVOKED");
    const failure = await source.sync(null).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SyncError);
    expect((failure as SyncError).kind).toBe("auth");
    expect(errors).toHaveLength(1);
    await expect(definition.credentialState!(ctx)).resolves.toMatchObject({ status: "unlinked" });
  });

  it("keeps two accounts' state apart", async () => {
    await seed(SELF);
    await seed(OTHER_ACCOUNT);
    const a = await context(String(SELF.id));
    const b = await context(String(OTHER_ACCOUNT.id));
    expect(a.storeId).not.toBe(b.storeId);
    expect(a.getArchive().getUser(OTHER_ACCOUNT.id)).toBeUndefined();
    expect(b.getArchive().getUser(SELF.id)).toBeUndefined();
    sim.revoke("SESSION_REVOKED", SELF.id);
    await expect(a.ensureUsable()).rejects.toMatchObject({ kind: "auth" });
    await expect(b.ensureUsable()).resolves.toBeUndefined();
  });

  it("removes one account's credential, archive and cache on cleanup", async () => {
    await seed(SELF);
    await seed(OTHER_ACCOUNT);
    await definition.cleanupCredentials!(String(SELF.id), { configDir });
    await expect(definition.discover!({ configDir })).resolves.toEqual([
      expect.objectContaining({ id: String(OTHER_ACCOUNT.id) }),
    ]);
  });

  /** Both accounts with chats of their own, connected, each with its source. */
  async function twoAccounts(): Promise<{
    a: { ctx: TelegramProvider; source: SourceInstance; dir: string };
    b: { ctx: TelegramProvider; source: SourceInstance; dir: string };
  }> {
    const mayaChat = privateChatWith(JAMIE);
    const jamieChat = privateChatWith(DAVID);
    sim = new SimulatedTelegram({
      self: SELF,
      users: [JAMIE],
      chats: [{ chat: mayaChat, messages: messageRun(mayaChat, JAMIE, 1, 3, T0) }],
    });
    sim.addAccount({
      self: OTHER_ACCOUNT,
      users: [DAVID],
      chats: [{ chat: jamieChat, messages: messageRun(jamieChat, DAVID, 1, 2, T0 + 86_400) }],
    });
    await seed(SELF);
    await seed(OTHER_ACCOUNT);
    const open = async (user: typeof SELF) => {
      const id = String(user.id);
      const ctx = await context(id);
      return { ctx, source: await instance(id, ctx), dir: join(configDir, "telegram", id) };
    };
    return { a: await open(SELF), b: await open(OTHER_ACCOUNT) };
  }

  async function drain(source: SourceInstance): Promise<string[]> {
    const ids: string[] = [];
    let cursor: unknown = null;
    for (let i = 0; i < 20; i++) {
      const page = await source.sync(cursor as never);
      ids.push(...page.documents.map((d) => d.externalId));
      cursor = page.cursor;
      if (!page.hasMore) return ids;
    }
    throw new Error("did not settle");
  }

  it("syncs two accounts at once into disjoint documents", async () => {
    const { a, b } = await twoAccounts();
    const [aDocs, bDocs] = await Promise.all([drain(a.source), drain(b.source)]);
    expect(aDocs).toEqual([`${JAMIE.id}:2026-03-10`]);
    expect(bDocs).toEqual([`${DAVID.id}:2026-03-11`]);
    expect(a.ctx.storeId).not.toBe(b.ctx.storeId);
  });

  it("keeps one account syncing while the other is suspended", async () => {
    const { a, b } = await twoAccounts();
    await a.source.suspend!();
    await expect(a.source.sync(null)).rejects.toMatchObject({ kind: "network" });
    await expect(drain(b.source)).resolves.toEqual([`${DAVID.id}:2026-03-11`]);
  });

  it("ends a removed account's Telegram session and leaves the other account whole", async () => {
    const { a, b } = await twoAccounts();
    await drain(b.source);
    // What a real client keeps beside the archive, for the survivor's check below.
    writeFileSync(join(b.dir, "mtcute.db"), "");
    const session = (await readSessionRecord(String(SELF.id), configDir))!.session;
    // The host unregisters the source first, then removes the credentials.
    await a.source.dispose!();
    await definition.cleanupCredentials!(String(SELF.id), { configDir });

    expect(sim.calls.filter((c) => c.method === "logOutSession")).toEqual([
      expect.objectContaining({ args: { session } }),
    ]);
    expect(sim.sessionIsActive(session)).toBe(false);
    expect(existsSync(a.dir)).toBe(false);
    expect(existsSync(join(b.dir, "archive.db"))).toBe(true);
    expect(existsSync(join(b.dir, "mtcute.db"))).toBe(true);
    sim.pushNew(
      DAVID.id,
      { text: "Rehearsal moved to Friday", date: T0 + 90_000 },
      OTHER_ACCOUNT.id,
    );
    await expect(drain(b.source)).resolves.toContain(`${DAVID.id}:2026-03-11`);
  });

  it("still removes an account whose session could not be ended, and says how to end it", async () => {
    await seed(SELF);
    sim.failNext("logOutSession", new TelegramError("network", "Connection reset"));
    await expect(definition.cleanupCredentials!(String(SELF.id), { configDir })).rejects.toThrow(
      /Settings → Devices/u,
    );
    expect(existsSync(join(configDir, "telegram", String(SELF.id)))).toBe(false);
  });

  it("leaves an account whose record cannot be read in place, so its session can still be ended", async () => {
    vi.stubEnv("OMNESIS_SECRET_STORE", "file");
    try {
      await ensureInstallRootKey({ configDir, backend: "file" });
      await seed(SELF);
      // The keyring is locked: the sealed record exists and cannot be opened.
      clearSecretFileKeyCacheForTests();
      await createSecretStore({ configDir, backend: "file" }).delete(OMNESIS_INSTALL_ROOT_KEY);
      const path = providerAccountCredentialsPath("telegram", String(SELF.id), configDir);
      await expect(
        definition.cleanupCredentials!(String(SELF.id), { configDir }),
      ).rejects.toThrow();
      expect(existsSync(path)).toBe(true);
      expect(sim.calls.some((c) => c.method === "logOutSession")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      clearSecretFileKeyCacheForTests();
    }
  });

  it("refuses lifecycle calls that name no config directory", async () => {
    await expect(definition.cleanupCredentials!(String(SELF.id))).rejects.toThrow(
      /config directory/u,
    );
    await expect(definition.discover!()).rejects.toThrow(/config directory/u);
  });
});
