// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { closeServer, listen } from "../test/support.js";
import { LoginAdmission } from "./admission.js";
import { LaunchTaken, launchCookie, serveLaunch, type LaunchView } from "./browser-launch.js";
import { RelayError } from "./tunnels.js";

const origin = "https://relay.example.test";
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await closeServer(server);
});

/** One sign-in link route over a real HTTP server, with a broker whose answers each test sets. */
async function fixture() {
  const broker = {
    view: { state: "open" } as LaunchView,
    peek: vi.fn((_input: { id: string; extra?: string }, _cookie: string) => broker.view),
    launch: vi.fn(
      (
        _input: { id: string; extra?: string },
        _cookie: string,
      ): { location: string; cookie?: string } => ({
        location: "/_relay/account?operation=1",
        cookie: "__Host-test=bound; Path=/",
      }),
    ),
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url!, origin);
    serveLaunch(req, res, url, {
      admission: new LoginAdmission(8, 60, { maxPerMinute: 30 }),
      origin,
      path: "/begin",
      names: { required: ["id"], optional: ["extra"] },
      parse: (fields) => (fields.id === "bad" ? undefined : (fields as { id: string })),
      peek: (input, cookie) => broker.peek(input, cookie),
      launch: (input, cookie) => broker.launch(input, cookie),
      restart: "To use this browser instead, start again.",
    }).catch((error: unknown) => {
      res.writeHead(error instanceof RelayError ? error.status : 500);
      res.end();
    });
  });
  servers.push(server);
  const url = await listen(server);
  const press = (body: string, headers: Record<string, string> = {}) =>
    fetch(url + "/begin", {
      method: "POST",
      redirect: "manual",
      headers: { origin, "content-type": "application/x-www-form-urlencoded", ...headers },
      body,
    });
  return { url, broker, press };
}

test("F43: opening a link shows a Continue page that posts its fields back, and changes nothing", async () => {
  const f = await fixture();
  const page = await fetch(f.url + "/begin?id=a%26%22b&extra=x", { redirect: "manual" });
  expect(page.status).toBe(200);
  expect(page.headers.getSetCookie()).toEqual([]);
  // Not `no-referrer`: under it the press would carry `Origin: null`.
  expect(page.headers.get("referrer-policy")).toBe("strict-origin");
  expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
  const html = await page.text();
  expect(html).toContain('<form method="post" action="/begin">');
  // Values are escaped into the hidden fields.
  expect(html).toContain('<input type="hidden" name="id" value="a&#38;&#34;b">');
  expect(html).toContain('<input type="hidden" name="extra" value="x">');
  expect(f.broker.launch).not.toHaveBeenCalled();

  // The browser that holds it goes straight back; another one is told so.
  f.broker.view = { state: "here", location: "/_relay/account?operation=1" };
  const back = await fetch(f.url + "/begin?id=a", {
    redirect: "manual",
    headers: { cookie: "c=1" },
  });
  expect(back.status).toBe(303);
  expect(back.headers.get("location")).toBe("/_relay/account?operation=1");
  expect(f.broker.peek).toHaveBeenLastCalledWith({ id: "a" }, "c=1");
  f.broker.view = { state: "taken" };
  const taken = await fetch(f.url + "/begin?id=a", { redirect: "manual" });
  expect(taken.status).toBe(409);
  expect(await taken.text()).toContain("To use this browser instead, start again.");
  expect(f.broker.launch).not.toHaveBeenCalled();
});

test("a link must carry exactly its own fields", async () => {
  const f = await fixture();
  for (const query of ["", "?extra=x", "?id=a&id=b", "?id=a&other=1", "?id=bad"])
    expect((await fetch(f.url + "/begin" + query)).status, query).toBe(400);
  expect((await fetch(f.url + "/begin?id=a", { method: "PUT" })).status).toBe(405);
  expect(f.broker.peek).not.toHaveBeenCalled();
});

test("only a press from the relay's own page binds, with exactly the link's fields", async () => {
  const f = await fixture();
  expect((await f.press("id=a", { origin: "https://elsewhere.example" })).status).toBe(403);
  expect((await f.press("id=a", { origin: "null" })).status).toBe(403);
  expect((await f.press("id=a", { "content-type": "application/json" })).status).toBe(415);
  expect((await f.press("x".repeat(2049))).status).toBe(413);
  expect(f.broker.launch).not.toHaveBeenCalled();
  const later = await fixture();
  for (const body of ["", "id=a&id=b", "id=a&other=1", "id=bad"])
    expect((await later.press(body)).status, body).toBe(400);
  expect(
    (
      await fetch(later.url + "/begin?id=a", {
        method: "POST",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
        body: "id=a",
      })
    ).status,
  ).toBe(400);
  expect(later.broker.launch).not.toHaveBeenCalled();
});

test("the press binds, keeps a browser that already holds it, and refuses another", async () => {
  const f = await fixture();
  const bound = await f.press("id=a&extra=x", { cookie: "c=1" });
  expect(bound.status).toBe(303);
  expect(bound.headers.get("location")).toBe("/_relay/account?operation=1");
  expect(bound.headers.getSetCookie()).toEqual(["__Host-test=bound; Path=/"]);
  expect(f.broker.launch).toHaveBeenLastCalledWith({ id: "a", extra: "x" }, "c=1");
  f.broker.launch.mockReturnValueOnce({ location: "/_relay/account?operation=1" });
  const again = await f.press("id=a");
  expect(again.status).toBe(303);
  expect(again.headers.getSetCookie()).toEqual([]);
  f.broker.launch.mockImplementationOnce(() => {
    throw new LaunchTaken();
  });
  const taken = await f.press("id=a");
  expect(taken.status).toBe(409);
  expect(taken.headers.getSetCookie()).toEqual([]);
  expect(await taken.text()).toContain("This sign-in was opened in another browser");
  f.broker.launch.mockImplementationOnce(() => {
    throw new RelayError(410, "Expired");
  });
  expect((await f.press("id=a")).status).toBe(410);
});

test("a binding cookie counts only when the browser sends exactly one", () => {
  expect(launchCookie("a=1; __Host-x=v; b=2", "__Host-x")).toBe("v");
  expect(launchCookie("__Host-x=v; __Host-x=w", "__Host-x")).toBeUndefined();
  expect(launchCookie("__Host-xy=v", "__Host-x")).toBeUndefined();
  expect(launchCookie("", "__Host-x")).toBeUndefined();
});
