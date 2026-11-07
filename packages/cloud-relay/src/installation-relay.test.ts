// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { DEFAULT_INSTALLATION_RELAY_URL, installationRelayUrl } from "./installation-relay.js";

test("new installations use one distribution service while existing operator choices remain local", () => {
  expect(installationRelayUrl({})).toBe(DEFAULT_INSTALLATION_RELAY_URL);
  expect(installationRelayUrl({}, "https://saved.example.test")).toBe("https://saved.example.test");
  expect(
    installationRelayUrl(
      { OMNESIS_CLOUD_RELAY_URL: "https://operator.example.test:443/" },
      "https://saved.example.test",
    ),
  ).toBe("https://operator.example.test");
  expect(installationRelayUrl({ OMNESIS_CLOUD_RELAY_URL: "http://127.0.0.1:32123" })).toBe(
    "http://127.0.0.1:32123",
  );
});
test("invalid explicit operator configuration fails closed instead of silently choosing a different service", () => {
  for (const value of [
    "",
    "not a URL",
    "http://remote.example.test",
    "https://operator.example.test/path",
    "https://user:@operator.example.test",
  ]) {
    expect(
      installationRelayUrl({ OMNESIS_CLOUD_RELAY_URL: value }, "https://saved.example.test"),
    ).toBeUndefined();
  }
  expect(installationRelayUrl({}, "invalid saved origin")).toBeUndefined();
});
