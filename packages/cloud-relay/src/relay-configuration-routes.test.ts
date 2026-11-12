// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { expect, test } from "vitest";
import { listen } from "../test/support.js";
import { createCloudRelay } from "./server.js";
import { RelayAccounts } from "./accounts.js";
import { hostedGatewayHostname } from "./hosted-name.js";
import { RelaySessions } from "./identity.js";
import type { AddressInfo } from "node:net";
test("public preparation discloses only bounded hosted routing metadata and rejects malformed UUID/query input", async () => {
  const accounts = new RelayAccounts(":memory:"),
    relay = createCloudRelay({
      accounts,
      sessions: new RelaySessions(randomBytes(32)),
      allowLoopbackEnrollment: true,
      relayDomain: "relay.example.test",
    });
  const url = await listen(relay.server);
  const gatewayId = randomUUID();
  try {
    expect(
      await (await fetch(`${url}/_relay/v2/config?gatewayId=${gatewayId}`)).json(),
    ).toMatchObject({
      protocol: 2,
      gatewayId,
      invitationRequired: false,
      publicOrigin: `https://${hostedGatewayHostname(gatewayId, "relay.example.test")}`,
    });
    relay.dataServer.listen(0, "127.0.0.1");
    await once(relay.dataServer, "listening");
    const response = await fetch(`${url}/_relay/v2/config?gatewayId=${gatewayId.toUpperCase()}`),
      value = await response.json();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(value).toMatchObject({
      gatewayId,
      publicOrigin: `https://${hostedGatewayHostname(gatewayId, "relay.example.test")}:${(relay.dataServer.address() as AddressInfo).port}`,
      dnsChallenges: false,
    });
    expect(JSON.stringify(value)).not.toMatch(/token|secret|key|account/i);
    for (const query of [
      "",
      "gatewayId=invalid",
      `gatewayId=${gatewayId}&gatewayId=${gatewayId}`,
      `gatewayId=${gatewayId}&extra=1`,
      `gatewayId=${"a".repeat(513)}`,
    ])
      expect((await fetch(`${url}/_relay/v2/config?${query}`)).status).toBe(400);
    expect(
      (await fetch(`${url}/_relay/v2/config?gatewayId=${gatewayId}`, { method: "POST" })).status,
    ).toBe(405);
  } finally {
    await relay.close();
    accounts.close();
  }
});
test("public recipient behind loopback still requires invitations and operator assigned public data port", async () => {
  for (const config of [
    {
      controlOrigin: "https://control.example.test",
      allowLoopbackEnrollment: true,
      publicDataPort: 7443,
      relayDomain: "relay.example.test",
    },
    { allowLoopbackEnrollment: false },
    { allowLoopbackEnrollment: true, controlOrigin: "http://127.0.0.1:1234" },
    { relayDomain: "invalid!" },
  ]) {
    const accounts = new RelayAccounts(":memory:"),
      relay = createCloudRelay({
        accounts,
        sessions: new RelaySessions(randomBytes(32)),
        ...config,
      });
    const url = await listen(relay.server),
      gatewayId = randomUUID();
    try {
      const response = await fetch(`${url}/_relay/v2/config?gatewayId=${gatewayId}`);
      if (config.relayDomain === "invalid!") expect(response.status).toBe(503);
      else {
        const value = await response.json();
        expect(value.invitationRequired).toBe(
          config.controlOrigin?.startsWith("http:") ? false : true,
        );
        if (config.publicDataPort)
          expect(value.publicOrigin).toBe(
            `https://${hostedGatewayHostname(gatewayId, "relay.example.test")}:7443`,
          );
        else expect(value.publicOrigin).toBeUndefined();
      }
    } finally {
      await relay.close();
      accounts.close();
    }
  }
});
test("explicit synthetic IPv6 loopback preparation agrees with the existing key-enrollment exemption", async () => {
  const accounts = new RelayAccounts(":memory:"),
    relay = createCloudRelay({
      accounts,
      sessions: new RelaySessions(randomBytes(32)),
      allowLoopbackEnrollment: true,
      controlOrigin: "http://[::1]:1234",
    });
  relay.server.listen(0, "::1");
  await once(relay.server, "listening");
  try {
    const response = await fetch(
      `http://[::1]:${(relay.server.address() as AddressInfo).port}/_relay/v2/config?gatewayId=${randomUUID()}`,
    );
    expect(await response.json()).toMatchObject({ invitationRequired: false });
  } finally {
    await relay.close();
    accounts.close();
  }
});
