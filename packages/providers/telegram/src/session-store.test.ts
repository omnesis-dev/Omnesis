// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OMNESIS_INSTALL_ROOT_KEY,
  clearSecretFileKeyCacheForTests,
  createSecretStore,
  ensureInstallRootKey,
  providerAccountCredentialsPath,
} from "@omnesis/core";
import {
  listSessionAccounts,
  markSessionRevoked,
  readSessionRecord,
  recordConnectionState,
  removeAccount,
  sessionConnectionState,
  writeSessionRecord,
  type TelegramSessionRecord,
} from "./session-store.js";
import { REVOCATION_REASONS } from "./client/types.js";
import { SELF, tempConfigDir } from "./testing/fixtures.js";

const ACCOUNT = String(SELF.id);
const RECORD: TelegramSessionRecord = {
  session: "invented-session-string-for-tests",
  userId: ACCOUNT,
  apiId: "1234567",
  phone: SELF.phone,
  username: SELF.username,
  connectedAt: "2026-03-10T09:00:00.000Z",
};

describe("Telegram session store", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = tempConfigDir("session");
    vi.stubEnv("OMNESIS_SECRET_STORE", "file");
    await ensureInstallRootKey({ configDir, backend: "file" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearSecretFileKeyCacheForTests();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("writes a wrapped record and reads it back", async () => {
    await writeSessionRecord(RECORD, configDir);
    const raw = readFileSync(
      providerAccountCredentialsPath("telegram", ACCOUNT, configDir),
      "utf8",
    );
    expect(raw).not.toContain(RECORD.session);
    expect(raw).not.toContain(SELF.phone!);
    await expect(readSessionRecord(ACCOUNT, configDir)).resolves.toEqual(RECORD);
    expect(listSessionAccounts(configDir)).toEqual([ACCOUNT]);
  });

  it("drops the session on revocation and keeps when and why", async () => {
    await writeSessionRecord(RECORD, configDir);
    await markSessionRevoked(
      ACCOUNT,
      "SESSION_REVOKED",
      configDir,
      new Date("2026-03-11T08:00:00Z"),
    );
    const record = await readSessionRecord(ACCOUNT, configDir);
    expect(record).toMatchObject({
      session: "",
      revokedAt: "2026-03-11T08:00:00.000Z",
      revokedReason: "SESSION_REVOKED",
      userId: ACCOUNT,
    });
    const raw = readFileSync(
      providerAccountCredentialsPath("telegram", ACCOUNT, configDir),
      "utf8",
    );
    expect(raw).not.toContain(RECORD.session);
    // Still discoverable, so the source can sit in needs-auth instead of vanishing.
    expect(listSessionAccounts(configDir)).toEqual([ACCOUNT]);
  });

  it("answers credentialState for every status from the record alone", async () => {
    await expect(sessionConnectionState(ACCOUNT, configDir)).resolves.toEqual({
      status: "never-connected",
    });
    await writeSessionRecord(RECORD, configDir);
    await expect(sessionConnectionState(ACCOUNT, configDir)).resolves.toEqual({
      status: "connected",
      since: RECORD.connectedAt,
    });
    for (const reason of REVOCATION_REASONS) {
      const state = recordConnectionState({
        ...RECORD,
        session: "",
        revokedAt: "2026-03-11T08:00:00.000Z",
        revokedReason: reason,
      });
      const deactivated = reason === "USER_DEACTIVATED" || reason === "USER_DEACTIVATED_BAN";
      expect(state.status, reason).toBe(deactivated ? "revoked" : "unlinked");
    }
    expect(
      recordConnectionState({ ...RECORD, session: "", revokedReason: "AUTH_KEY_DUPLICATED" }),
    ).toEqual({
      status: "unlinked",
      detail: "This Omnesis session was ended from another Telegram device.",
    });
  });

  it("reports a record it cannot decrypt as unknown, not as never connected", async () => {
    await writeSessionRecord(RECORD, configDir);
    await createSecretStore({ configDir, backend: "file" }).delete(OMNESIS_INSTALL_ROOT_KEY);
    clearSecretFileKeyCacheForTests();
    await expect(sessionConnectionState(ACCOUNT, configDir)).resolves.toMatchObject({
      status: "unknown",
    });
  });

  it("removes only the one account's directory", async () => {
    await writeSessionRecord(RECORD, configDir);
    await writeSessionRecord({ ...RECORD, userId: "5550100102" }, configDir);
    await removeAccount(ACCOUNT, configDir);
    expect(listSessionAccounts(configDir)).toEqual(["5550100102"]);
  });
});
