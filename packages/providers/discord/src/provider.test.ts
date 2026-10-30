// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordClient } from "./client.js";
import {
  authFlow,
  cleanupCredentials,
  discoverAccounts,
  hasCredentials,
  loadToken,
} from "./provider.js";
import { BOT, MAYA } from "./fake-discord.js";

const configDir = () => mkdtempSync(join(tmpdir(), "omnesis-discord-auth-"));

const INVITE =
  "https://discord.com/oauth2/authorize?client_id=800000000000000001&scope=bot&permissions=66560";

/** Keep the post-write invite lookup off the network in every auth test. */
function stubInvite() {
  return vi.spyOn(DiscordClient.prototype, "inviteUrl").mockResolvedValue(INVITE);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authFlow", () => {
  it("probes the token, stores it under the bot user's id, and reports the account offline", async () => {
    vi.spyOn(DiscordClient.prototype, "getMe").mockResolvedValue(BOT);
    const invite = stubInvite();
    const dir = configDir();
    const account = await authFlow(
      undefined,
      { credentials: { token: "valid-token" } } as never,
      { configDir: dir } as never,
    );
    expect(String(account)).toBe(BOT.id);
    expect(hasCredentials(BOT.id, dir)).toBe(true);
    expect(discoverAccounts(dir).map(String)).toEqual([BOT.id]);
    expect(await loadToken(BOT.id, dir)).toBe("valid-token");
    // The invite link is the one thing the operator cannot look up; it is
    // built once the account exists, not asked for in the Developer Portal.
    expect(invite).toHaveBeenCalled();
  });

  it("connects the account even when the invite link cannot be built", async () => {
    vi.spyOn(DiscordClient.prototype, "getMe").mockResolvedValue(BOT);
    vi.spyOn(DiscordClient.prototype, "inviteUrl").mockRejectedValue(new Error("HTTP 503"));
    const dir = configDir();
    const account = await authFlow(
      undefined,
      { credentials: { token: "valid-token" } } as never,
      { configDir: dir } as never,
    );
    expect(String(account)).toBe(BOT.id);
    expect(hasCredentials(BOT.id, dir)).toBe(true);
  });

  it("refuses a user-account token and writes nothing", async () => {
    vi.spyOn(DiscordClient.prototype, "getMe").mockResolvedValue(MAYA);
    const dir = configDir();
    await expect(
      authFlow(
        undefined,
        { credentials: { token: "valid-token" } } as never,
        { configDir: dir } as never,
      ),
    ).rejects.toThrow(/not a bot/);
    expect(discoverAccounts(dir)).toEqual([]);
  });

  it("writes nothing when the probe fails", async () => {
    vi.spyOn(DiscordClient.prototype, "getMe").mockRejectedValue(new Error("HTTP 401"));
    const dir = configDir();
    await expect(
      authFlow(undefined, { credentials: { token: "bad" } } as never, { configDir: dir } as never),
    ).rejects.toThrow(/401/);
    expect(discoverAccounts(dir)).toEqual([]);
  });

  it("refuses a re-auth with a token belonging to a different bot", async () => {
    vi.spyOn(DiscordClient.prototype, "getMe").mockResolvedValue({
      ...BOT,
      id: "900000000000000009",
    });
    await expect(
      authFlow(
        undefined,
        { accountId: BOT.id, credentials: { token: "valid-token" } } as never,
        { configDir: configDir() } as never,
      ),
    ).rejects.toThrow(/not to the bot this source was added with/);
  });

  it("keeps two bots as separate accounts and removes only the one asked for", async () => {
    const other = { ...BOT, id: "900000000000000009", username: "second-bot" };
    stubInvite();
    const spy = vi.spyOn(DiscordClient.prototype, "getMe");
    const dir = configDir();
    spy.mockResolvedValueOnce(BOT);
    await authFlow(
      undefined,
      { credentials: { token: "valid-token" } } as never,
      { configDir: dir } as never,
    );
    spy.mockResolvedValueOnce(other);
    await authFlow(
      undefined,
      { credentials: { token: "valid-token" } } as never,
      { configDir: dir } as never,
    );
    expect(discoverAccounts(dir).map(String).sort()).toEqual([BOT.id, other.id].sort());

    await cleanupCredentials(BOT.id, dir);
    expect(hasCredentials(BOT.id, dir)).toBe(false);
    expect(hasCredentials(other.id, dir)).toBe(true);
  });
});
