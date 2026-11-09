// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { configuredConnectShortUrl, connectShortUrlSchema } from "./connect-short-url.js";

test("a short connect address is a bounded https URL without credentials", () => {
  expect(connectShortUrlSchema.parse("https://front.example.test/connect")).toBe(
    "https://front.example.test/connect",
  );
  expect(connectShortUrlSchema.parse("https://front.example.test")).toBe(
    "https://front.example.test/",
  );
  for (const value of [
    "",
    "front.example.test/connect",
    "/connect",
    "http://front.example.test/connect",
    "javascript:alert(1)",
    "https://name@front.example.test/connect",
    "https://name:secret@front.example.test/connect",
    "https://front.example.test/" + "c".repeat(200),
  ])
    expect(connectShortUrlSchema.safeParse(value).success, value).toBe(false);
  expect(connectShortUrlSchema.safeParse(7).success).toBe(false);
});

test("the relay's own setting also refuses a query or fragment, and names itself when refused", () => {
  expect(configuredConnectShortUrl(undefined)).toBeUndefined();
  expect(configuredConnectShortUrl(" https://front.example.test/connect ")).toBe(
    "https://front.example.test/connect",
  );
  for (const value of [
    "",
    " ",
    "front.example.test/connect",
    "http://front.example.test/connect",
    "https://name@front.example.test/connect",
    "https://front.example.test/connect?code=1",
    "https://front.example.test/connect?",
    "https://front.example.test/connect#top",
    "https://front.example.test/connect#",
    "https://front.example.test/" + "c".repeat(200),
  ])
    expect(() => configuredConnectShortUrl(value), value).toThrow(
      "OMNESIS_CLOUD_RELAY_CONNECT_SHORT_URL must be an https URL",
    );
});
