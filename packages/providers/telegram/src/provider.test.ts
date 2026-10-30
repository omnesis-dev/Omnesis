// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncError } from "@omnesis/types";
import { REVOKED_REMEDIATION, TelegramProvider } from "./provider.js";
import { readSessionRecord, writeSessionRecord } from "./session-store.js";
import { REVOCATION_REASONS, TelegramError, type TelegramAdapter } from "./client/types.js";
import { SimulatedTelegram } from "./testing/simulated-telegram.js";
import { OTHER_ACCOUNT, SELF, tempConfigDir, writeAppCredentials } from "./testing/fixtures.js";

const ACCOUNT = String(SELF.id);

describe("TelegramProvider", () => {
  let configDir: string;
  let stateDir: string;
  let sim: SimulatedTelegram;
  const open: TelegramProvider[] = [];

  async function seedSession(session: string): Promise<void> {
    await writeSessionRecord(
      { session, userId: ACCOUNT, apiId: "1234567", connectedAt: "2026-03-10T09:00:00.000Z" },
      configDir,
    );
  }

  async function openProvider(): Promise<TelegramProvider> {
    const provider = await TelegramProvider.open({
      accountId: ACCOUNT,
      configDir,
      stateDir,
      factory: sim.factory,
      now: () => new Date("2026-03-11T08:00:00.000Z"),
    });
    open.push(provider);
    await provider.ready();
    return provider;
  }

  beforeEach(async () => {
    configDir = tempConfigDir("provider");
    stateDir = join(configDir, "telegram", ACCOUNT);
    await writeAppCredentials(configDir);
    sim = new SimulatedTelegram({ self: SELF });
    sim.addAccount({ self: OTHER_ACCOUNT });
    await seedSession(sim.issueSession(SELF.id));
  });

  afterEach(async () => {
    for (const provider of open.splice(0)) await provider.dispose();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("connects from the stored session and keeps the account's own user", async () => {
    const provider = await openProvider();
    await expect(provider.ensureUsable()).resolves.toBeUndefined();
    await expect(provider.credentialState()).resolves.toMatchObject({ status: "connected" });
    expect(provider.getArchive().getUser(SELF.id)).toMatchObject({
      displayName: "Maya Reeves",
      phoneE164: "+12025550101",
    });
    expect(sim.activeConnections).toBe(1);
    expect(sim.calls.map((c) => c.method)).not.toContain("signInQr");
  });

  it("refuses to build a context for an account with no session or an ended one", async () => {
    rmSync(join(configDir, "telegram"), { recursive: true, force: true });
    await expect(openProvider()).rejects.toThrow(/no stored session/u);
    await writeSessionRecord(
      {
        session: "",
        userId: ACCOUNT,
        apiId: "1234567",
        connectedAt: "2026-03-10T09:00:00.000Z",
        revokedAt: "2026-03-11T08:00:00.000Z",
        revokedReason: "SESSION_REVOKED",
      },
      configDir,
    );
    await expect(openProvider()).rejects.toThrow(/re-authenticate/u);
  });

  it("refuses those as auth failures carrying the re-authentication remedy", async () => {
    rmSync(join(configDir, "telegram"), { recursive: true, force: true });
    const failure = await openProvider().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(SyncError);
    expect(failure).toMatchObject({ kind: "auth", remediation: REVOKED_REMEDIATION });
  });

  it.each(REVOCATION_REASONS)(
    "a session ended with %s rewrites the record, reports the error, and fails syncs as auth",
    async (reason) => {
      const provider = await openProvider();
      const errors: string[] = [];
      provider.onSourceError((e) => errors.push(e));
      sim.revoke(reason);

      const failure = await provider.ensureUsable().catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(SyncError);
      expect((failure as SyncError).kind).toBe("auth");
      expect((failure as SyncError).remediation).toEqual(REVOKED_REMEDIATION);
      expect(errors).toHaveLength(1);

      const record = await readSessionRecord(ACCOUNT, configDir);
      expect(record).toMatchObject({ session: "", revokedReason: reason });
      expect(record?.revokedAt).toBe("2026-03-11T08:00:00.000Z");
      const deactivated = reason === "USER_DEACTIVATED" || reason === "USER_DEACTIVATED_BAN";
      await expect(provider.credentialState()).resolves.toMatchObject({
        status: deactivated ? "revoked" : "unlinked",
      });
      // The client is stopped, and the next sync fails the same way without asking.
      expect(sim.activeConnections).toBe(0);
      const calls = sim.calls.length;
      await expect(provider.ensureUsable()).rejects.toMatchObject({ kind: "auth" });
      expect(sim.calls.length).toBe(calls);
      await provider.resume();
      expect(sim.activeConnections).toBe(0);
    },
  );

  it("treats a session that was already ended before the restart as revoked", async () => {
    sim.revoke("SESSION_REVOKED");
    const provider = await openProvider();
    await expect(provider.ensureUsable()).rejects.toMatchObject({ kind: "auth" });
    await expect(provider.credentialState()).resolves.toMatchObject({ status: "unlinked" });
  });

  it("refuses a session that resolves to another user", async () => {
    await seedSession(sim.issueSession(OTHER_ACCOUNT.id));
    const provider = await openProvider();
    await expect(provider.ensureUsable()).rejects.toMatchObject({ kind: "auth" });
    await expect(readSessionRecord(ACCOUNT, configDir)).resolves.toMatchObject({
      session: "",
      revokedReason: "AUTH_KEY_DUPLICATED",
    });
  });

  it("restarts without signing in again: a new context reconnects from the same session", async () => {
    const first = await openProvider();
    const storeId = first.storeId;
    const firstSession = (await readSessionRecord(ACCOUNT, configDir))!.session;
    await first.dispose();
    expect(sim.activeConnections).toBe(0);

    const second = await openProvider();
    await expect(second.ensureUsable()).resolves.toBeUndefined();
    // Same archive, same session, and no sign-in anywhere.
    expect(second.storeId).toBe(storeId);
    expect((await readSessionRecord(ACCOUNT, configDir))!.session).toBe(firstSession);
    expect(sim.calls.filter((c) => c.method === "connect")).toHaveLength(2);
    expect(sim.calls.map((c) => c.method)).not.toContain("signInQr");
  });

  it("retries a connect that failed for a network reason on the next sync", async () => {
    sim.failNext("connect", new TelegramError("network", "Connection reset"));
    const provider = await openProvider();
    await expect(provider.ensureUsable()).resolves.toBeUndefined();
    expect(sim.calls.filter((c) => c.method === "connect")).toHaveLength(2);
  });

  it("fails a sync as a rate limit when the authorization check is flood-limited", async () => {
    const provider = await openProvider();
    sim.floodWait("checkAuthorization", 30);
    await expect(provider.ensureUsable()).rejects.toMatchObject({
      kind: "rate-limit",
      retryAfterMs: 30_000,
    });
    await expect(provider.credentialState()).resolves.toMatchObject({ status: "connected" });
  });

  it("suspend and resume never stack connections", async () => {
    const provider = await openProvider();
    await provider.suspend();
    await provider.suspend();
    expect(sim.activeConnections).toBe(0);
    await expect(provider.ensureUsable()).rejects.toMatchObject({ kind: "network" });
    await provider.resume();
    await provider.resume();
    expect(sim.activeConnections).toBe(1);
    await provider.suspend();
    await provider.resume();
    expect(sim.activeConnections).toBe(1);
    await expect(provider.ensureUsable()).resolves.toBeUndefined();
  });

  it("connects a rebuilt context only once the previous one on the directory has closed", async () => {
    const first = await openProvider();
    const connects = () => sim.calls.filter((c) => c.method === "connect").length;
    // The host opens the new context before its disposal of the old one has finished.
    const second = await TelegramProvider.open({
      accountId: ACCOUNT,
      configDir,
      stateDir,
      factory: sim.factory,
    });
    open.push(second);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connects()).toBe(1);
    expect(sim.activeConnections).toBe(1);

    await first.dispose();
    await second.ready();
    const order = sim.calls.map((c) => c.method).filter((m) => m === "connect" || m === "close");
    expect(order).toEqual(["connect", "close", "connect"]);
    expect(sim.activeConnections).toBe(1);
    await expect(second.ensureUsable()).resolves.toBeUndefined();
    await expect(readSessionRecord(ACCOUNT, configDir)).resolves.toMatchObject({
      session: expect.stringMatching(/^sim-session:/u),
    });
  });

  it("never makes one account wait for another", async () => {
    const first = await openProvider();
    await writeSessionRecord(
      {
        session: sim.issueSession(OTHER_ACCOUNT.id),
        userId: String(OTHER_ACCOUNT.id),
        apiId: "1234567",
        connectedAt: "2026-03-10T09:00:00.000Z",
      },
      configDir,
    );
    const other = await TelegramProvider.open({
      accountId: String(OTHER_ACCOUNT.id),
      configDir,
      stateDir: join(configDir, "telegram", String(OTHER_ACCOUNT.id)),
      factory: sim.factory,
    });
    open.push(other);
    await other.ready();
    expect(sim.activeConnections).toBe(2);
    await expect(first.ensureUsable()).resolves.toBeUndefined();
    await expect(other.ensureUsable()).resolves.toBeUndefined();
  });

  it("closes once the last source built on it is released, and not before", async () => {
    const provider = await openProvider();
    const a = provider.attach();
    const b = provider.attach();
    await a();
    await a();
    expect(sim.activeConnections).toBe(1);
    await b();
    expect(sim.activeConnections).toBe(0);
    await provider.whenClosed;
  });

  it("gives up waiting for the connection when the sync is cancelled", async () => {
    const provider = await openProvider();
    await provider.suspend();
    await provider.dispose();
    const blocked = await TelegramProvider.open({
      accountId: ACCOUNT,
      configDir,
      stateDir,
      factory: { ...sim.factory, live: (...args) => hangingConnect(sim.factory.live(...args)) },
    });
    open.push(blocked);
    const controller = new AbortController();
    const pending = blocked.ensureUsable(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "network" });
  });

  it("dispose is idempotent and closes the client", async () => {
    const provider = await openProvider();
    await provider.dispose();
    await provider.dispose();
    expect(sim.activeConnections).toBe(0);
    expect(sim.calls.filter((c) => c.method === "close")).toHaveLength(1);
  });
});

/** An adapter whose connect never settles until it is closed. */
function hangingConnect(adapter: TelegramAdapter): TelegramAdapter {
  return Object.assign(Object.create(adapter) as TelegramAdapter, {
    connect: () => new Promise<never>(() => undefined),
  });
}
