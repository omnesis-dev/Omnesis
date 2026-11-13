// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { closeServer, listen } from "../test/support.js";
import { LoginAdmission } from "./admission.js";
import { ConnectCodes } from "./connect-codes.js";
import { ConnectHttp } from "./connect-http.js";
import { RelayError } from "./tunnels.js";

const origin = "https://relay.example.test";
const inFive = () => Math.floor(Date.now() / 1000) + 300;
const launch = () => ({ location: "/_relay/account?desktop=fixture", cookie: "fixture=1" });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0)) await close();
});

test("codes are eight base32 characters and redeem until they expire, however they are typed", () => {
  const codes = new ConnectCodes(),
    claim = vi.fn(launch),
    code = codes.issue(inFive(), claim);
  expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  expect(codes.claim(` ${code.toLowerCase().replace("-", " - ")} `, "fixture-cookie")).toEqual(
    launch(),
  );
  expect(claim).toHaveBeenCalledWith("fixture-cookie");
  // The operation behind the code decides whether it may still be launched, not this table.
  expect(codes.claim(code, "again")).toEqual(launch());
  expect(claim).toHaveBeenLastCalledWith("again");
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 301_000 });
  expect(() => codes.claim(code, "")).toThrow("not valid");
});

test("the 40 random bits map onto the whole alphabet, and a collision draws again", () => {
  const draws = [Buffer.alloc(5, 0), Buffer.alloc(5, 0), Buffer.alloc(5, 0xff)];
  const codes = new ConnectCodes({ random: () => draws.shift()! });
  expect(codes.issue(inFive(), launch)).toBe("AAAA-AAAA");
  expect(codes.issue(inFive(), launch)).toBe("7777-7777");
  expect(draws).toEqual([]);
});

test("guessing is capped per minute across all callers, and the cap resets", () => {
  vi.useFakeTimers({ toFake: ["Date"], now: 60_000_000 });
  const codes = new ConnectCodes({ maxAttemptsPerMinute: 2 }),
    code = codes.issue(inFive(), launch);
  expect(() => codes.claim("AAAA-AAAA", "")).toThrow("not valid");
  expect(() => codes.claim("AAAA-AAAB", "")).toThrow("not valid");
  // A correct code is refused at the cap too, so the cap can't be used to confirm a guess.
  expect(() => codes.claim(code, "")).toThrow("Too many");
  vi.setSystemTime(60_060_000);
  expect(codes.claim(code, "")).toEqual(launch());
});

test("expired codes stop working, and live codes are bounded", () => {
  const codes = new ConnectCodes({ maxCodes: 1 }),
    code = codes.issue(inFive(), launch);
  expect(() => codes.issue(inFive(), launch)).toThrow("Too many");
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 301_000 });
  expect(() => codes.claim(code, "")).toThrow("not valid");
  expect(codes.issue(inFive(), launch)).toMatch(/-/);
});

async function http(maxPerMinute = 60) {
  const codes = new ConnectCodes(),
    service = new ConnectHttp({ origin, codes, admission: new LoginAdmission(8, maxPerMinute) });
  const server = createServer((req, res) => {
    void service
      .handle(req, res)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      })
      .catch((error: unknown) => {
        res.writeHead(error instanceof RelayError ? error.status : 500);
        res.end();
      });
  });
  const url = await listen(server);
  cleanup.push(() => closeServer(server));
  const claim = (body: unknown, headers: Record<string, string> = {}, query = "") =>
    fetch(`${url}/_relay/v3/connect/claim${query}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { url, codes, claim };
}

test("the claim sets the launch cookie and returns a same-origin location", async () => {
  const f = await http(),
    code = f.codes.issue(inFive(), launch);
  const response = await f.claim({ code });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ location: "/_relay/account?desktop=fixture" });
  expect(response.headers.get("set-cookie")).toBe("fixture=1");
  expect((await f.claim({ code })).status).toBe(200);
});

test("the claim passes the browser's existing cookies to the launch", async () => {
  const f = await http(),
    claimed = vi.fn(launch),
    code = f.codes.issue(inFive(), claimed);
  await f.claim({ code }, { cookie: "existing=1" });
  expect(claimed).toHaveBeenCalledWith("existing=1");
});

test("the claim boundary refuses other sites, other shapes and other methods", async () => {
  const f = await http();
  expect(
    (await f.claim({ code: "AAAA-AAAA" }, { origin: "https://foreign.example.test" })).status,
  ).toBe(403);
  expect((await f.claim({ code: "AAAA-AAAA" }, { "sec-fetch-site": "cross-site" })).status).toBe(
    403,
  );
  expect((await f.claim({ code: "AAAA-AAAA" }, { "content-type": "text/plain" })).status).toBe(415);
  expect((await f.claim({ code: "AAAA-AAAA" }, {}, "?code=AAAA-AAAA")).status).toBe(400);
  expect((await f.claim({ code: "" })).status).toBe(400);
  expect((await f.claim({ code: "AAAA-AAAA", extra: 1 })).status).toBe(400);
  expect((await f.claim({ code: "x".repeat(2000) })).status).toBe(413);
  expect((await fetch(`${f.url}/_relay/v3/connect/claim`)).status).toBe(405);
  expect((await fetch(`${f.url}/_relay/connect`, { method: "POST" })).status).toBe(405);
  expect((await fetch(`${f.url}/_relay/unrelated`)).status).toBe(404);
});

test("the claim shares the relay's login admission", async () => {
  const f = await http(1);
  expect((await f.claim({ code: "AAAA-AAAA" })).status).toBe(404);
  expect((await f.claim({ code: "AAAA-AAAA" })).status).toBe(429);
});

test("the connect page is self-only and asks for the code", async () => {
  const f = await http();
  const page = await fetch(`${f.url}/_relay/connect`);
  const html = await page.text();
  expect(html).toContain('id="connect-code"');
  expect(html).not.toMatch(/<script(?![^>]*src="\/_relay\/connect\/script\.js")/);
  const policy = page.headers.get("content-security-policy");
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(page.headers.get("cache-control")).toBe("no-store");
  const script = await fetch(`${f.url}/_relay/connect/script.js`);
  expect(script.headers.get("content-type")).toContain("application/javascript");
  expect(await script.text()).toContain("/_relay/v3/connect/claim");
});
