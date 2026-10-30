// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissingCredentialsError, listProviderAccountIds } from "@omnesis/core";
import { AuthFailure } from "@omnesis/source-sdk";
import { loginFlow, removeConnectedAccount } from "./auth.js";
import { mapRpcError } from "./client/errors.js";
import { readSessionRecord, writeSessionRecord } from "./session-store.js";
import { SimulatedTelegram } from "./testing/simulated-telegram.js";
import {
  OTHER_ACCOUNT,
  SELF,
  scriptedSession,
  tempConfigDir,
  until,
  writeAppCredentials,
} from "./testing/fixtures.js";
import type { QrChallenge } from "@omnesis/source-sdk";

describe("Telegram sign-in", () => {
  let configDir: string;
  let sim: SimulatedTelegram;

  beforeEach(async () => {
    configDir = tempConfigDir("auth");
    await writeAppCredentials(configDir);
    sim = new SimulatedTelegram({ self: SELF });
    sim.addAccount({ self: OTHER_ACCOUNT });
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  /** Nothing but the app credential the test itself wrote. */
  function expectNothingPersisted(): void {
    expect(listProviderAccountIds("telegram", configDir)).toEqual([]);
    expect(existsSync(join(configDir, "telegram"))).toBe(false);
  }

  const qrs = (shown: ReturnType<typeof scriptedSession>["shown"]) =>
    shown.filter((c): c is QrChallenge => c.kind === "qr");

  it("shows a replacement code with its expiry each time the code rotates, then connects", async () => {
    const { session, shown } = scriptedSession(configDir);
    const flow = loginFlow(session, { factory: sim.factory });
    await until(() => qrs(shown).length === 1);
    sim.qr.rotate();
    await until(() => qrs(shown).length === 2);
    const [first, second] = qrs(shown);
    expect(first!.data).not.toBe(second!.data);
    for (const qr of [first!, second!]) {
      expect(qr.data).toMatch(/^tg:\/\/login\?token=/u);
      expect(Date.parse(qr.expiresAt!)).toBeGreaterThan(Date.now());
      expect(qr.title).toBe("Scan this code with Telegram");
      // Every sign-in points at Telegram's terms instead of restating them.
      expect(qr.instructions).toContain("https://telegram.org/tos");
      expect(qr.instructions).toContain("https://core.telegram.org/api/terms");
    }
    sim.qr.scan(SELF.id);
    await expect(flow).resolves.toMatchObject({
      accounts: [{ accountId: String(SELF.id), state: { status: "connected" } }],
    });
    expect(shown.some((c) => c.kind === "wait")).toBe(true);

    const record = await readSessionRecord(String(SELF.id), configDir);
    expect(record).toMatchObject({
      userId: String(SELF.id),
      apiId: "1234567",
      phone: SELF.phone,
      username: SELF.username,
    });
    expect(sim.sessionIsActive(record!.session)).toBe(true);
    // The sign-in client is closed whether or not the flow succeeded.
    expect(sim.calls.map((c) => c.method)).toContain("authClose");
  });

  it("reports honest device metadata without the platform's name in it", async () => {
    const { session } = scriptedSession(configDir);
    const flow = loginFlow(session, { factory: sim.factory });
    await until(() => sim.calls.some((c) => c.method === "signInQr"));
    sim.qr.scan(SELF.id);
    await flow;
    const [device] = sim.devices;
    expect(device!.deviceModel).toBe("Omnesis");
    expect(device!.langCode).toBe("en");
    expect(JSON.stringify(device)).not.toMatch(/telegram/iu);
  });

  it("asks for the two-step password, asks again after a wrong one, and never stores it", async () => {
    sim.requirePassword("invented-cloud-password");
    const { session, asked } = scriptedSession(configDir, {
      passwords: ["wrong-guess", "invented-cloud-password"],
    });
    const flow = loginFlow(session, { factory: sim.factory });
    await until(() => sim.calls.some((c) => c.method === "signInQr"));
    sim.qr.scan(SELF.id);
    await expect(flow).resolves.toMatchObject({ accounts: [{ accountId: String(SELF.id) }] });
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({
      kind: "fields",
      title: "Enter your two-step verification password",
    });
    const record = await readSessionRecord(String(SELF.id), configDir);
    expect(JSON.stringify(record)).not.toContain("invented-cloud-password");
  });

  it("gives up as credential-rejected after three wrong passwords and stores nothing", async () => {
    sim.requirePassword("invented-cloud-password");
    const { session, asked } = scriptedSession(configDir, {
      passwords: ["one", "two", "three", "four"],
    });
    const flow = loginFlow(session, { factory: sim.factory });
    await until(() => sim.calls.some((c) => c.method === "signInQr"));
    sim.qr.scan(SELF.id);
    const failure = await flow.catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AuthFailure);
    expect((failure as AuthFailure).code).toBe("credential-rejected");
    expect(asked).toHaveLength(3);
    expectNothingPersisted();
  });

  it("refuses a password-protected account as unsupported when the client cannot ask", async () => {
    sim.requirePassword("invented-cloud-password");
    const { session, asked } = scriptedSession(configDir, { renders: ["qr", "wait"] });
    const flow = loginFlow(session, { factory: sim.factory });
    await until(() => sim.calls.some((c) => c.method === "signInQr"));
    sim.qr.scan(SELF.id);
    const failure = (await flow.catch((e: unknown) => e)) as AuthFailure;
    expect(failure.code).toBe("unsupported");
    expect(failure.remedy).toMatch(/two-step password/u);
    expect(asked).toHaveLength(0);
    expectNothingPersisted();
  });

  it("refuses a re-authentication scanned by another account and ends that authorization", async () => {
    const { session } = scriptedSession(configDir, { accountId: String(SELF.id) });
    const flow = loginFlow(session, { factory: sim.factory });
    await until(() => sim.calls.some((c) => c.method === "signInQr"));
    sim.qr.scan(OTHER_ACCOUNT.id);
    const failure = (await flow.catch((e: unknown) => e)) as AuthFailure;
    expect(failure).toBeInstanceOf(AuthFailure);
    expect(failure.code).toBe("identity-mismatch");
    expect(failure.remedy).toMatch(/Scan with the Telegram account/u);
    expect(sim.calls.map((c) => c.method)).toContain("logOut");
    expectNothingPersisted();
  });

  it("renews the same account on re-authentication", async () => {
    await writeSessionRecord(
      {
        session: "",
        userId: String(SELF.id),
        apiId: "1234567",
        connectedAt: "2026-01-01T00:00:00.000Z",
        revokedAt: "2026-01-02T00:00:00.000Z",
        revokedReason: "SESSION_REVOKED",
      },
      configDir,
    );
    const { session } = scriptedSession(configDir, { accountId: String(SELF.id) });
    const flow = loginFlow(session, { factory: sim.factory });
    await until(() => sim.calls.some((c) => c.method === "signInQr"));
    sim.qr.scan(SELF.id);
    await flow;
    const record = await readSessionRecord(String(SELF.id), configDir);
    expect(record?.revokedAt).toBeUndefined();
    expect(record?.session).toMatch(/^sim-session:/u);
  });

  it("refuses to add an account that is already connected", async () => {
    await writeSessionRecord(
      {
        session: sim.issueSession(SELF.id),
        userId: String(SELF.id),
        apiId: "1234567",
        connectedAt: "2026-01-01T00:00:00.000Z",
      },
      configDir,
    );
    const { session } = scriptedSession(configDir);
    const flow = loginFlow(session, { factory: sim.factory });
    await until(() => sim.calls.some((c) => c.method === "signInQr"));
    sim.qr.scan(SELF.id);
    const failure = (await flow.catch((e: unknown) => e)) as AuthFailure;
    expect(failure.code).toBe("duplicate");
    expect(sim.calls.map((c) => c.method)).toContain("logOut");
  });

  it("sends the operator to the wizard when the app credential is missing", async () => {
    rmSync(join(configDir, "telegram-credentials.json"));
    const { session } = scriptedSession(configDir);
    await expect(loginFlow(session, { factory: sim.factory })).rejects.toBeInstanceOf(
      MissingCredentialsError,
    );
    expect(sim.calls).toEqual([]);
    expectNothingPersisted();
  });

  it("maps a flood wait to unavailable with the wait Telegram named", async () => {
    sim.floodWait("signInQr", 42);
    const { session } = scriptedSession(configDir);
    const failure = (await loginFlow(session, { factory: sim.factory }).catch(
      (e: unknown) => e,
    )) as AuthFailure;
    expect(failure.code).toBe("unavailable");
    expect(failure.retryAfterMs).toBe(42_000);
    expectNothingPersisted();
  });

  it.each([
    [403, "USER_DEACTIVATED", "denied"],
    [401, "USER_DEACTIVATED_BAN", "denied"],
    [400, "PHONE_NUMBER_BANNED", "denied"],
    [400, "PHONE_NUMBER_INVALID", "credential-rejected"],
    [400, "AUTH_TOKEN_INVALID", "credential-rejected"],
    [401, "AUTH_KEY_UNREGISTERED", "credential-rejected"],
    [400, "AUTH_TOKEN_EXPIRED", "challenge-expired"],
    [420, "PHONE_NUMBER_FLOOD", "unavailable"],
    [400, "SOMETHING_ELSE_ENTIRELY", "unknown"],
  ])("maps a %s %s refusal to %s and stores nothing", async (code, text, expected) => {
    sim.failNext("signInQr", mapRpcError({ code, text }));
    const { session } = scriptedSession(configDir);
    const failure = (await loginFlow(session, { factory: sim.factory }).catch(
      (e: unknown) => e,
    )) as AuthFailure;
    expect(failure).toBeInstanceOf(AuthFailure);
    expect(failure.code).toBe(expected);
    expectNothingPersisted();
  });

  it("times out when nobody scans, and stores nothing", async () => {
    const { session } = scriptedSession(configDir);
    const failure = (await loginFlow(session, { factory: sim.factory, timeoutMs: 30 }).catch(
      (e: unknown) => e,
    )) as AuthFailure;
    expect(failure.code).toBe("timeout");
    expectNothingPersisted();
  });

  it("removes an account whose logout hangs once the wait runs out", async () => {
    await writeSessionRecord(
      {
        session: sim.issueSession(SELF.id),
        userId: String(SELF.id),
        apiId: "1234567",
        connectedAt: "2026-03-10T09:00:00.000Z",
      },
      configDir,
    );
    const hanging = {
      ...sim.factory,
      auth: (...args: Parameters<typeof sim.factory.auth>) => {
        const real = sim.factory.auth(...args);
        return {
          ...real,
          close: () => real.close(),
          logOutSession: (_session: string, opts: { signal: AbortSignal }) =>
            new Promise<void>((_resolve, reject) =>
              opts.signal.addEventListener("abort", () => reject(new Error("aborted"))),
            ),
        };
      },
    };
    const stateDir = join(configDir, "telegram", String(SELF.id));
    await expect(
      removeConnectedAccount(String(SELF.id), configDir, {
        factory: hanging,
        stateDir,
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/timed out/u);
    expect(existsSync(stateDir)).toBe(false);
  });

  it("removes an account whose session already ended without asking Telegram", async () => {
    await writeSessionRecord(
      {
        session: "",
        userId: String(SELF.id),
        apiId: "1234567",
        connectedAt: "2026-03-10T09:00:00.000Z",
        revokedAt: "2026-03-11T08:00:00.000Z",
        revokedReason: "SESSION_REVOKED",
      },
      configDir,
    );
    const stateDir = join(configDir, "telegram", String(SELF.id));
    await removeConnectedAccount(String(SELF.id), configDir, { factory: sim.factory, stateDir });
    expect(existsSync(stateDir)).toBe(false);
    expect(sim.calls).toEqual([]);
  });
});
