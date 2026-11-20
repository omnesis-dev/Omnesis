// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { afterEach, expect, test } from "vitest";
import { closeServer, listen } from "../test/support.js";
import { InviteHttp } from "./invite-http.js";
import type { RelayError } from "./tunnels.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await closeServer(server);
});

async function serve() {
  const pages = new InviteHttp("https://relay.example.test");
  const server = createServer((req, res) => {
    try {
      if (!pages.handle(req, res)) res.writeHead(404).end();
    } catch (error) {
      res.writeHead((error as RelayError).status).end();
    }
  });
  servers.push(server);
  return listen(server);
}

test("the invite page and its script are served with a strict policy, and nothing else is", async () => {
  const url = await serve();
  const page = await fetch(`${url}/invite`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  const html = await page.text();
  expect(html).toContain('<script type="module" src="/invite/script.js">');
  expect(html).toContain("Settings, then Connectivity, then Omnesis account");
  // The script shows one of the two states once it has read the fragment; neither shows before.
  expect(html).toContain('<div id="invite-missing" hidden><h1>This link has no invite in it</h1>');
  expect(html).toContain('<div id="invite-found"><h1>You\'re invited to Omnesis</h1>');
  expect(html).toContain('<code id="invite-command"></code>');
  const script = await fetch(`${url}/invite/script.js`);
  expect(script.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
  expect(await script.text()).toMatch(/^\(function installInviteUI\(\)/);
  expect((await fetch(`${url}/invite`, { method: "POST" })).status).toBe(405);
  expect((await fetch(`${url}/invite/other`)).status).toBe(404);
  expect((await fetch(`${url}/invites`)).status).toBe(404);
});
