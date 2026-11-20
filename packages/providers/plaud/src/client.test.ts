// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { SyncError } from "@omnesis/types";
import { PlaudClient, audioMimeType, login, refreshTokens, sendCode } from "./client.js";
import { EU_BASE, FAKE_EMAIL, FakePlaud, GLOBAL_BASE } from "./fake-plaud.js";
import { plaudApiBase } from "./hosts.js";
import type { PlaudTokens } from "./client.js";

function client(fake: FakePlaud, tokens: Partial<PlaudTokens> = {}, now = 1_900_000_000) {
  const stored: PlaudTokens[] = [];
  const c = new PlaudClient(
    EU_BASE,
    { accessToken: fake.accessToken, refreshToken: fake.refreshToken, ...tokens },
    {
      fetchImpl: fake.fetch,
      nowSeconds: () => now,
      onTokens: async (t) => void stored.push(t),
      listingPageSize: 2,
    },
  );
  return { c, stored };
}

async function syncError(p: Promise<unknown>): Promise<SyncError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SyncError);
  return err as SyncError;
}

describe("plaudApiBase", () => {
  test.each([
    ["https://api-euc1.plaud.ai", "https://api-euc1.plaud.ai"],
    ["https://api.plaud.cn/", "https://api.plaud.cn"],
    ["https://plaud.ai", "https://plaud.ai"],
  ])("accepts %s", (input, expected) => expect(plaudApiBase(input)).toBe(expected));

  test.each([
    "http://api.plaud.ai",
    "https://api.plaud.ai.example.com",
    "https://evilplaud.ai",
    // A URL carrying credentials, spelled without an address-like literal.
    ["https://", "user:pw", "@", "api.plaud.ai"].join(""),
    "https://api.plaud.ai/other",
    "not a url",
  ])("refuses %s", (input) => expect(plaudApiBase(input)).toBeUndefined());
});

describe("sign-in", () => {
  test("follows the regional redirect and redeems the code there", async () => {
    const fake = new FakePlaud();
    const otp = await sendCode(FAKE_EMAIL, { fetchImpl: fake.fetch });
    expect(otp).toEqual({ otpToken: "otp-token", apiBase: EU_BASE });
    expect(fake.requests[0]).toContain("api.plaud.ai/auth/otp-send-code");
    const tokens = await login(otp.apiBase, "246810", otp.otpToken, { fetchImpl: fake.fetch });
    expect(tokens).toEqual({
      accessToken: "ut-1",
      refreshToken: "rt-1",
      accessExpiresAt: 2_000_000_000,
      sessionExpiresAt: 2_100_000_000,
    });
  });

  test("refuses a redirect to a host that is not Plaud's", async () => {
    const fake = new FakePlaud();
    fake.home = "https://plaud.example.com";
    await expect(sendCode(FAKE_EMAIL, { fetchImpl: fake.fetch })).rejects.toThrow(/not Plaud's/);
  });

  test("gives up on a redirect loop", async () => {
    const fake = new FakePlaud();
    fake.home = "https://api-loop.plaud.ai";
    const loop: typeof fetch = (input, init) => {
      // Every host answers that the account lives on the next one.
      fake.home = fake.home === EU_BASE ? GLOBAL_BASE : EU_BASE;
      return fake.fetch(input, init);
    };
    await expect(sendCode(FAKE_EMAIL, { fetchImpl: loop })).rejects.toThrow(/too many times/);
  });

  test("an unknown address and a wrong code are auth failures", async () => {
    const fake = new FakePlaud();
    fake.home = GLOBAL_BASE;
    expect((await syncError(sendCode("jamie@example.com", { fetchImpl: fake.fetch }))).kind).toBe(
      "auth",
    );
    expect(
      (await syncError(login(GLOBAL_BASE, "000000", "otp-token", { fetchImpl: fake.fetch }))).kind,
    ).toBe("auth");
  });

  test("a refresh keeps the refresh token when Plaud does not rotate it", async () => {
    const fake = new FakePlaud();
    const tokens = await refreshTokens(EU_BASE, "rt-1", { fetchImpl: fake.fetch });
    expect(tokens.accessToken).toBe("ut-2");
    expect(tokens.refreshToken).toBe("rt-1");
  });

  test("a refused refresh ends the sign-in, an outage does not", async () => {
    const fake = new FakePlaud();
    fake.refreshRefused = true;
    const ended = await syncError(refreshTokens(EU_BASE, "rt-1", { fetchImpl: fake.fetch }));
    expect([ended.kind, ended.scope]).toEqual(["auth", "connection"]);
    fake.refreshRefused = false;
    fake.failNext = { match: "/auth/refresh-user-token", status: 503 };
    expect((await syncError(refreshTokens(EU_BASE, "rt-1", { fetchImpl: fake.fetch }))).kind).toBe(
      "transient",
    );
  });
});

describe("data requests", () => {
  test("carry a workspace token minted for the personal workspace", async () => {
    const fake = new FakePlaud();
    fake.addRecording({ id: "rec-1" });
    const { c } = client(fake);
    await c.listFiles();
    expect(fake.requests).toContain(
      "POST api-euc1.plaud.ai/user-app/auth/workspace/token/personal-1",
    );
  });

  test("re-mint a rejected workspace token once before touching the user token", async () => {
    const fake = new FakePlaud();
    const { c, stored } = client(fake);
    await c.listFiles();
    fake.revokedWorkspaceTokens.add("wt-1");
    await c.listFiles();
    expect(fake.workspaceToken).toBe("wt-2");
    expect(stored).toEqual([]);
  });

  test("renew a rejected user token and store the new one", async () => {
    const fake = new FakePlaud();
    fake.mintFailure = 500;
    const { c, stored } = client(fake);
    fake.revokedAccessTokens.add("ut-1");
    await c.listFiles();
    expect(stored.map((t) => t.accessToken)).toEqual(["ut-2"]);
  });

  test("renew a user token about to expire before using it", async () => {
    const fake = new FakePlaud();
    const { c, stored } = client(fake, { accessExpiresAt: 1_900_000_100 });
    await c.listFiles();
    expect(stored.map((t) => t.accessToken)).toEqual(["ut-2"]);
  });

  test("report the sign-in ended when renewal is refused", async () => {
    const fake = new FakePlaud();
    fake.mintFailure = 500;
    fake.refreshRefused = true;
    fake.revokedAccessTokens.add("ut-1");
    const err = await syncError(client(fake).c.listFiles());
    expect([err.kind, err.scope]).toEqual(["auth", "connection"]);
  });

  test("report the sign-in ended once the session is over, without asking Plaud", async () => {
    const fake = new FakePlaud();
    const err = await syncError(client(fake, { sessionExpiresAt: 1_800_000_000 }).c.listFiles());
    expect(err.kind).toBe("auth");
    expect(fake.requests).toEqual([]);
  });

  test("carry Plaud's Retry-After on a rate limit", async () => {
    const fake = new FakePlaud();
    fake.failNext = { match: "/file/simple/web", status: 429, headers: { "retry-after": "30" } };
    const err = await syncError(client(fake).c.listFiles());
    expect([err.kind, err.retryAfterMs]).toEqual(["rate-limit", 30_000]);
  });

  test("an outage is transient and an unreachable host is a network failure", async () => {
    const fake = new FakePlaud();
    fake.failNext = { match: "/file/simple/web", status: 502 };
    expect((await syncError(client(fake).c.listFiles())).kind).toBe("transient");
    const down = new PlaudClient(
      EU_BASE,
      { accessToken: "ut-1" },
      { fetchImpl: () => Promise.reject(new TypeError("fetch failed")) },
    );
    expect((await syncError(down.listFiles())).kind).toBe("network");
  });

  test("a malformed listing entry fails the listing", async () => {
    const fake = new FakePlaud();
    const broken: typeof fetch = async (input, init) => {
      const res = await fake.fetch(input, init);
      if (!String(input).includes("/file/simple/web")) return res;
      return new Response(
        JSON.stringify({ status: 0, data_file_total: 1, data_file_list: [{ id: "rec-1" }] }),
      );
    };
    const c = new PlaudClient(EU_BASE, { accessToken: "ut-1" }, { fetchImpl: broken });
    await expect(c.listFiles()).rejects.toThrow(/invalid recording listing/);
  });
});

describe("listing", () => {
  test("reads every page and is consistent when the totals agree", async () => {
    const fake = new FakePlaud();
    for (const id of ["a", "b", "c", "d", "e"]) fake.addRecording({ id });
    const listing = await client(fake).c.listFiles();
    expect(listing.files.map((f) => f.id).sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(listing.consistent).toBe(true);
  });

  test("is inconsistent when the total disagrees with what was listed", async () => {
    const fake = new FakePlaud();
    for (const id of ["a", "b", "c"]) fake.addRecording({ id });
    fake.totalSkew = 1;
    expect((await client(fake).c.listFiles()).consistent).toBe(false);
  });

  test("is inconsistent when an edit moves a recording between pages mid-read", async () => {
    const fake = new FakePlaud();
    for (const id of ["a", "b", "c", "d"]) fake.addRecording({ id });
    let pages = 0;
    const moving: typeof fetch = async (input, init) => {
      if (String(input).includes("/file/simple/web") && pages++ === 1) {
        // The oldest recording is edited after the first page was read.
        fake.edit("a", { filename: "Renamed" });
      }
      return fake.fetch(input, init);
    };
    const c = new PlaudClient(
      EU_BASE,
      { accessToken: "ut-1" },
      {
        fetchImpl: moving,
        listingPageSize: 2,
      },
    );
    expect((await c.listFiles()).consistent).toBe(false);
  });
});

describe("content and audio", () => {
  test("gunzips a transcript behind its link", async () => {
    const fake = new FakePlaud();
    fake.addRecording({ id: "rec-1", is_trans: true, transcript: [{ content: "Hello" }] });
    const { c } = client(fake);
    const detail = await c.getDetail("rec-1");
    const link = detail.content_list![0]!.data_link!;
    await expect(c.fetchContent(link)).resolves.toEqual([{ content: "Hello" }]);
  });

  test("a recording Plaud refuses to serve is an item failure, the account is not", async () => {
    const fake = new FakePlaud();
    fake.addRecording({ id: "rec-1" });
    fake.failNext = { match: "/file/detail/rec-1", status: 403 };
    const err = await syncError(client(fake).c.getDetail("rec-1"));
    expect([err.kind, err.scope]).toEqual(["permission", "item"]);
    fake.failNext = { match: "/file/simple/web", status: 403 };
    expect((await syncError(client(fake).c.listFiles())).scope).toBe("source");
  });

  test("a recording Plaud no longer has is an item failure", async () => {
    const err = await syncError(client(new FakePlaud()).c.getDetail("gone"));
    expect(err.scope).toBe("item");
  });

  test("asks for a fresh audio link when the first has expired", async () => {
    const fake = new FakePlaud();
    fake.addRecording({ id: "rec-1", audio: new Uint8Array([9, 8, 7]) });
    fake.expireNextLinks = 2;
    const audio = await client(fake).c.downloadAudio("rec-1", 1000);
    expect(audio).toEqual({ bytes: new Uint8Array([9, 8, 7]), mimeType: "audio/ogg" });
    expect(fake.requests.filter((r) => r.includes("/file/temp-url/"))).toHaveLength(2);
  });

  test("does not download audio larger than the limit", async () => {
    const fake = new FakePlaud();
    fake.addRecording({ id: "rec-1", audio: new Uint8Array(50) });
    await expect(client(fake).c.downloadAudio("rec-1", 10)).resolves.toEqual({ tooLarge: true });
  });

  test.each([
    ["/a/rec.opus", null, "audio/ogg"],
    ["/a/rec.mp3", null, "audio/mpeg"],
    ["/a/rec", "audio/wav; x=1", "audio/wav"],
    ["/a/rec", "application/octet-stream", "audio/mpeg"],
  ])("names %s (%s) %s", (path, type, expected) => {
    expect(audioMimeType(path, type)).toBe(expected);
  });
});
