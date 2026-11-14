// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { join } from "node:path";
import { DEFAULT_CONFIG_DIR } from "@omnesis/core";
import { expect, test } from "vitest";
import {
  cloudClientDefaults,
  requireGoogleDesktopClient,
  DEFAULT_GOOGLE_DESKTOP_CLIENT_ID,
  CloudClientSetupError,
} from "./client-defaults.js";
test("client defaults are private local paths and public installation metadata, with independent desktop trust absent until configured", () => {
  expect(() => cloudClientDefaults({ OMNESIS_CONFIG_DIR: " " })).toThrow("configuration directory");
  const defaults = cloudClientDefaults({});
  expect(defaults.OMNESIS_CLOUD_RELAY_URL).toBe("https://relay.omnesis.app");
  expect(defaults.OMNESIS_CLOUD_RELAY_DEVICE_FILE).toBe(
    join(DEFAULT_CONFIG_DIR, "cloud-relay", "cli-device.json"),
  );
  expect(defaults.OMNESIS_CLOUD_RELAY_DEVICE_NAME).toBe("Omnesis CLI");
  expect(DEFAULT_GOOGLE_DESKTOP_CLIENT_ID).toBeUndefined();
  expect(() => requireGoogleDesktopClient(defaults)).toThrow("unavailable");
  expect(() =>
    requireGoogleDesktopClient({ OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID: " " }),
  ).toThrow();
  expect(() =>
    requireGoogleDesktopClient({
      OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID: "operator-desktop",
    }),
  ).not.toThrow();
  const collector = cloudClientDefaults({
    OMNESIS_CONFIG_DIR: "/synthetic/config",
    OMNESIS_CLOUD_RELAY_DEVICE_KIND: "collector",
  });
  expect(collector.OMNESIS_CLOUD_RELAY_DEVICE_NAME).toBe("Omnesis collector");
  expect(collector.OMNESIS_CLOUD_RELAY_DEVICE_FILE).toBe(
    join("/synthetic/config", "cloud-relay", "collector-device.json"),
  );
  expect(collector.OMNESIS_CLOUD_RELAY_SESSION_FILE).toBe(
    join("/synthetic/config", "cloud-relay", "client-session.json"),
  );
  expect(collector.OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE).toBe(
    join("/synthetic/config", "cloud-relay", "google-client.json"),
  );
  const explicit = {
    OMNESIS_CONFIG_DIR: "/synthetic/config",
    OMNESIS_CLOUD_RELAY_URL: "https://other.example.test",
    OMNESIS_CLOUD_RELAY_SESSION_FILE: "session",
    OMNESIS_CLOUD_RELAY_GOOGLE_CREDENTIALS_FILE: "credentials",
    OMNESIS_CLOUD_RELAY_DEVICE_FILE: "device",
    OMNESIS_CLOUD_RELAY_DEVICE_NAME: "Chosen name",
    OMNESIS_CLOUD_RELAY_GOOGLE_DESKTOP_CLIENT_ID: "operator-desktop",
    OMNESIS_CLOUD_RELAY_DEVICE_KIND: "collector",
  };
  expect(cloudClientDefaults(explicit)).toEqual(explicit);
  expect(new CloudClientSetupError("CLOUD_CLIENT_TOKEN_COLLISION").message).toContain(
    "separate OMNESIS_CONFIG_DIR",
  );
});
