// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { SyncError } from "@omnesis/types";
import { DiscordClient } from "./client.js";
import { FakeDiscord, MAYA, msg } from "./fake-discord.js";

function client(fake: FakeDiscord, token = "valid-token") {
  const sleeps: number[] = [];
  const c = new DiscordClient(token, {
    fetchImpl: fake.fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { c, sleeps };
}

describe("DiscordClient", () => {
  it("sends the bot authorization and the User-Agent Discord requires", async () => {
    const fake = new FakeDiscord();
    const { c } = client(fake);
    await c.getMe();
    const [req] = fake.requests;
    expect(req.headers.authorization).toBe("Bot valid-token");
    expect(req.headers["user-agent"]).toMatch(/^DiscordBot \(https:\/\/omnesis\.dev, /);
  });

  it("classifies a rejected token as an auth error that names the user-token case", async () => {
    const fake = new FakeDiscord();
    const { c } = client(fake, "stale");
    await expect(c.getMe()).rejects.toMatchObject({
      kind: "auth",
      message: expect.stringMatching(/user-account token/),
    });
  });

  it("stops waiting on a rate limit as soon as the sync is aborted", async () => {
    const fake = new FakeDiscord();
    fake.scripted.push({
      match: "/users/@me",
      status: 429,
      body: { retry_after: 2, global: false },
    });
    const controller = new AbortController();
    const c = new DiscordClient("valid-token", {
      fetchImpl: fake.fetch,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    });
    await expect(c.getMe(controller.signal)).rejects.toThrow(/abort/i);
    expect(fake.requests.length).toBe(1);
  });

  it("surfaces a refused guild listing as a permission error with the grant to make", async () => {
    const fake = new FakeDiscord();
    fake.addGuild("1", "Northstar");
    fake.forbiddenGuilds.add("1");
    const { c } = client(fake);
    const err = await c.listGuildChannels("1").catch((e) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect(err.kind).toBe("permission");
    expect(err.remediation?.steps.join(" ")).toMatch(/Read Message History/);
  });

  it("tells an unreadable channel from a missing one, neither being an error", async () => {
    const fake = new FakeDiscord();
    fake.addGuild("1", "Northstar");
    fake.addChannel("1", { id: "10", type: 0, name: "general" });
    fake.forbidden.add("10");
    const { c } = client(fake);
    expect(await c.listMessages("10", "0")).toEqual({ kind: "forbidden" });
    expect(await c.listMessages("11", "0")).toEqual({ kind: "gone" });
  });

  it("returns messages oldest first whatever order Discord sends", async () => {
    const fake = new FakeDiscord();
    fake.addGuild("1", "Northstar");
    fake.addChannel("1", { id: "10", type: 0, name: "general" });
    fake.post(msg("10", MAYA, "2026-03-08T09:00:00.000Z", "first"));
    fake.post(msg("10", MAYA, "2026-03-08T09:05:00.000Z", "second"));
    const { c } = client(fake);
    const page = await c.listMessages("10", "0");
    expect(page.kind).toBe("ok");
    if (page.kind !== "ok") return;
    expect(page.rows.map((r) => r.content)).toEqual(["first", "second"]);
    expect(page.full).toBe(false);
    expect(page.after).toBe(page.rows[1].id);
  });

  it("drops rows it cannot read before sorting, and still reports a full page as full", async () => {
    const fake = new FakeDiscord();
    fake.addGuild("1", "Northstar");
    fake.addChannel("1", { id: "10", type: 0, name: "general" });
    const good = fake.post(msg("10", MAYA, "2026-03-08T09:00:00.000Z", "fine"));
    fake.post({ ...msg("10", MAYA, "2026-03-08T09:01:00.000Z", "no id"), id: undefined as never });
    fake.post({ ...msg("10", MAYA, "2026-03-08T09:02:00.000Z", "bad id"), id: "abc" });
    const { c } = client(fake);
    const page = await c.listMessages("10", "0");
    expect(page).toMatchObject({ kind: "ok", full: false, after: good.id });
    if (page.kind === "ok") expect(page.rows.map((r) => r.content)).toEqual(["fine"]);

    const junk = Array.from({ length: 100 }, (_, i) => ({ foo: i }));
    fake.scripted.push({ match: "/channels/10/messages", status: 200, body: junk });
    await expect(c.listMessages("10", "0")).rejects.toMatchObject({
      kind: "unknown",
      message: expect.stringMatching(/no readable message/),
    });
  });

  it("sleeps through a short rate limit and retries once", async () => {
    const fake = new FakeDiscord();
    fake.scripted.push({
      match: "/users/@me",
      status: 429,
      body: { retry_after: 0.25, global: false },
    });
    const { c, sleeps } = client(fake);
    const me = await c.getMe();
    expect(me.bot).toBe(true);
    expect(sleeps).toEqual([250]);
  });

  it("keeps sleeping through consecutive short rate limits until the inline budget is spent", async () => {
    const fake = new FakeDiscord();
    fake.scripted.push(
      { match: "/users/@me", status: 429, body: { retry_after: 0.3 } },
      { match: "/users/@me", status: 429, body: { retry_after: 0.3 } },
    );
    const { c, sleeps } = client(fake);
    expect((await c.getMe()).bot).toBe(true);
    expect(sleeps).toEqual([300, 300]);

    fake.scripted.push(
      { match: "/users/@me", status: 429, body: { retry_after: 9 } },
      { match: "/users/@me", status: 429, body: { retry_after: 2 } },
    );
    await expect(c.getMe()).rejects.toMatchObject({ kind: "rate-limit", retryAfterMs: 2_000 });
    expect(sleeps).toEqual([300, 300, 9_000]);
  });

  it("defers a long rate limit to the scheduler with Discord's retry_after", async () => {
    const fake = new FakeDiscord();
    fake.scripted.push({
      match: "/users/@me",
      status: 429,
      body: { retry_after: 42, global: true },
    });
    const { c, sleeps } = client(fake);
    await expect(c.getMe()).rejects.toMatchObject({ kind: "rate-limit", retryAfterMs: 42_000 });
    expect(sleeps).toEqual([]);
  });

  it("stops waiting on a server-error or network backoff as soon as the sync is aborted", async () => {
    const fake = new FakeDiscord();
    fake.scripted.push({ match: "/users/@me", status: 502 });
    const controller = new AbortController();
    const c = new DiscordClient("valid-token", {
      fetchImpl: fake.fetch,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    });
    await expect(c.getMe(controller.signal)).rejects.toThrow(/abort/i);
    expect(fake.requests.length).toBe(1);

    let calls = 0;
    const flaky = new AbortController();
    const n = new DiscordClient("valid-token", {
      fetchImpl: () => {
        calls++;
        return Promise.reject(new Error("ECONNRESET"));
      },
      sleep: () => {
        flaky.abort();
        return Promise.resolve();
      },
    });
    await expect(n.getMe(flaky.signal)).rejects.toThrow(/abort/i);
    expect(calls).toBe(1);
  });

  it("retries a server error twice before giving up as transient", async () => {
    const fake = new FakeDiscord();
    fake.scripted.push({ match: "/users/@me", status: 502 }, { match: "/users/@me", status: 503 });
    const { c, sleeps } = client(fake);
    expect((await c.getMe()).bot).toBe(true);
    expect(sleeps).toEqual([1000, 3000]);

    fake.scripted.push(
      { match: "/users/@me", status: 502 },
      { match: "/users/@me", status: 502 },
      { match: "/users/@me", status: 502 },
    );
    await expect(c.getMe()).rejects.toMatchObject({ kind: "transient" });
  });

  it("wraps a network failure as a network error after retries", async () => {
    const c = new DiscordClient("valid-token", {
      fetchImpl: () => Promise.reject(new Error("ECONNRESET")),
      sleep: () => Promise.resolve(),
    });
    await expect(c.getMe()).rejects.toMatchObject({ kind: "network" });
  });
});
