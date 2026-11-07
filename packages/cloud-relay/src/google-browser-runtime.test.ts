// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { googleBrowserFixture } from "../test/google-browser-fixture.js";
import { googleBrowserConfiguration } from "./google-browser-runtime.js";
import { GoogleBrowserBroker } from "./google-browser-broker.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "google-browser-runtime-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const origin = "https://relay.example.test";

test("managed browser OAuth is optional and native public audiences require no gateway browser secret", async () => {
  expect(await googleBrowserConfiguration({}, undefined, [], [])).toBeUndefined();
  expect(
    await googleBrowserConfiguration(
      { OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: origin },
      undefined,
      [],
      [],
    ),
  ).toBeUndefined();
  expect(
    await googleBrowserConfiguration(
      { OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CLIENT_ID: "operator-client" },
      undefined,
      [],
      [],
    ),
  ).toBeUndefined();
  const configured = await googleBrowserConfiguration(
    { OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: origin },
    undefined,
    ["native-client"],
    ["native-client", "android-presenter"],
  );
  expect(configured).toEqual({
    ownerLink: undefined,
    deviceEnrollment: undefined,
    deviceClientIds: ["native-client"],
    deviceAuthorizedParties: ["native-client", "android-presenter"],
  });
  const broker = new GoogleBrowserBroker({ ...configured!, origin, currentOwner: () => undefined });
  expect(broker.configuration()).toEqual({
    protocol: "omnesis-google-browser-v1",
    deviceClientIds: ["native-client"],
    deviceAuthorizedParties: ["native-client", "android-presenter"],
  });
  broker.close();
});

test("shared operator web credentials enable both roles while public configuration exposes only client IDs", async () => {
  const f = await googleBrowserFixture(directory),
    secretFile = join(directory, "operator-web.json");
  await writeFile(
    secretFile,
    JSON.stringify({
      web: {
        client_id: "operator-owner-client",
        client_secret: "operator-test-key",
        redirect_uris: [origin + "/_relay/v2/google/browser/callback"],
      },
    }),
    { mode: 0o600 },
  );
  const env = {
    OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: origin,
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CLIENT_ID: "operator-owner-client",
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_SECRET_FILE: secretFile,
  };
  const device = f.configuration.deviceEnrollment!;
  const configured = await googleBrowserConfiguration(
    env,
    device,
    [device.clientId, "ios-client"],
    [device.clientId, "ios-client", "android-client"],
  );
  expect(configured?.deviceEnrollment).toBe(device);
  expect(configured?.ownerLink).toMatchObject({
    clientId: "operator-owner-client",
    clientSecret: "operator-test-key",
  });
  expect(configured?.ownerLink?.identity).toHaveProperty("verify", expect.any(Function));
  const broker = new GoogleBrowserBroker({ ...configured!, origin, currentOwner: () => undefined });
  const publicConfiguration = broker.configuration();
  expect(publicConfiguration).toEqual({
    protocol: "omnesis-google-browser-v1",
    ownerLinkClientId: "operator-owner-client",
    deviceEnrollmentClientId: device.clientId,
    deviceClientIds: [device.clientId, "ios-client"],
    deviceAuthorizedParties: [device.clientId, "ios-client", "android-client"],
  });
  expect(JSON.stringify(publicConfiguration)).not.toContain("operator-test-key");
  expect(JSON.stringify(publicConfiguration)).not.toContain(device.clientSecret);
  expect(JSON.stringify(publicConfiguration)).not.toContain(secretFile);
  broker.close();
  const ownerOnly = await googleBrowserConfiguration(env, undefined, [], []);
  expect(ownerOnly?.ownerLink?.clientId).toBe("operator-owner-client");
  expect(ownerOnly?.deviceEnrollment).toBeUndefined();
  const deviceOnly = await googleBrowserConfiguration(
    { OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: origin },
    device,
    [device.clientId],
    [device.clientId],
  );
  expect(deviceOnly?.ownerLink).toBeUndefined();
  expect(deviceOnly?.deviceEnrollment).toBe(device);
});

test("partial or malformed operator credentials fail with static errors containing no secret or private path", async () => {
  const secretFile = join(directory, "private-operator.json");
  for (const env of [
    { OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_SECRET_FILE: secretFile },
    {
      OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_SECRET_FILE: secretFile,
      OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CLIENT_ID: "owner-client",
    },
    {
      OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_SECRET_FILE: secretFile,
      OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: origin,
    },
  ])
    await expect(googleBrowserConfiguration(env, undefined, [], [])).rejects.toThrow(
      "requires an operator client ID and public relay origin",
    );
  const configured = {
    OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: origin,
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_CLIENT_ID: "owner-client",
    OMNESIS_CLOUD_RELAY_GOOGLE_GATEWAY_WEB_SECRET_FILE: secretFile,
  };
  const refused = async () => {
    try {
      await googleBrowserConfiguration(configured, undefined, [], []);
      throw new Error("Expected malformed credentials to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Invalid operator Google owner web credential file");
      expect(error).not.toHaveProperty("cause");
    }
  };
  await refused();
  for (const value of [
    "invalid operator-test-key JSON",
    "x".repeat(65_537),
    JSON.stringify({
      installed: { client_id: "owner-client", client_secret: "operator-test-key" },
    }),
    JSON.stringify({ web: { client_id: "wrong-client", client_secret: "operator-test-key" } }),
    JSON.stringify({ web: { client_id: "owner-client", client_secret: " " } }),
    JSON.stringify({ web: { client_id: "owner-client", client_secret: "x".repeat(8193) } }),
  ]) {
    await writeFile(secretFile, value, { mode: 0o600 });
    await refused();
  }
  await expect(
    googleBrowserConfiguration(
      { OMNESIS_CLOUD_RELAY_PUBLIC_ORIGIN: "https://user:password@relay.example.test" },
      undefined,
      [],
      [],
    ),
  ).rejects.toThrow();
});
