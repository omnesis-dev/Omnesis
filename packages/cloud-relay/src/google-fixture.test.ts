// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { expect, test } from "vitest";
import { closeServer, listen } from "../test/support.js";
import { googleFixture } from "./google-fixture.js";

test("the google fixture is only for a synthetic loopback relay and serves only google's api origins", async () => {
  expect(googleFixture(undefined, "0.0.0.0", false)).toBeUndefined();
  for (const [value, bind, synthetic] of [
    ["http://127.0.0.1:9/", "0.0.0.0", true],
    ["http://127.0.0.1:9/", "127.0.0.1", false],
    ["https://google.example.com/", "127.0.0.1", true],
    ["http://127.0.0.1:9/prefix", "127.0.0.1", true],
  ] as const)
    expect(() => googleFixture(value, bind, synthetic)).toThrow();
  const fixture = googleFixture("http://127.0.0.1:9/", "::1", true)!;
  expect(fixture.authorizationEndpoint).toBe("http://127.0.0.1:9/o/oauth2/v2/auth");
  expect(() => fixture.fetch("https://example.com/token")).toThrow("serves only");
  expect(() => fixture.fetch(new URL("https://example.com/token"))).toThrow("serves only");
  expect(() => fixture.fetch(new Request("https://oauth2.googleapis.com/token"))).toThrow(
    "takes a URL",
  );
});

test("the google fixture sends a call to google's token endpoint to the stand-in, path and query unchanged", async () => {
  const server = createServer((req, res) => res.end(`${req.method} ${req.url}`));
  const url = await listen(server);
  try {
    const fixture = googleFixture(`${url}/`, "127.0.0.1", true)!;
    const reply = await fixture.fetch("https://oauth2.googleapis.com/token?x=1", {
      method: "POST",
    });
    expect(await reply.text()).toBe("POST /token?x=1");
    expect(() => fixture.fetch("https://cloudidentity.googleapis.com/v1/groups")).toThrow(
      "serves only",
    );
  } finally {
    await closeServer(server);
  }
});
