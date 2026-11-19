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
test("synthetic, test and spawned E2E gateways never fall back to the distribution service", () => {
  for (const marker of [
    { OMNESIS_SYNTHETIC: "1" },
    { OMNESIS_TEST_INSTANCE: "1" },
    { OMNESIS_E2E_DISABLE_DEFAULT_RELAY: "1" },
  ]) {
    expect(installationRelayUrl(marker)).toBeUndefined();
    // A relay named for the instance, or one it already uses, is still honoured.
    expect(
      installationRelayUrl({ ...marker, OMNESIS_CLOUD_RELAY_URL: "http://127.0.0.1:32123" }),
    ).toBe("http://127.0.0.1:32123");
    expect(installationRelayUrl(marker, "https://saved.example.test")).toBe(
      "https://saved.example.test",
    );
  }
  // Only the exact opt-in counts, as for every other Omnesis flag.
  expect(installationRelayUrl({ OMNESIS_TEST_INSTANCE: "0" })).toBe(DEFAULT_INSTALLATION_RELAY_URL);
});
