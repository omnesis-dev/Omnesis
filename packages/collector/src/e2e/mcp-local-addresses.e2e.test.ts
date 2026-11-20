// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// MCP agents on the gateway's own computer and on the home network, against a
// spawned gateway: a local client signs in and calls a tool over the plain
// loopback address with no certificate step, and over a home-network address
// once the owner allows it — refused while it is off — and a home-network
// resource the configuration already names keeps working whatever the choice.

import "./synth-env.js";

import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { interfaceIdentities } from "@omnesis/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { authorizeMcpClient, beginMcpAuthorization } from "./mcp-oauth-helper.js";
import { getFreePort } from "./multi-collector-harness.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

/**
 * This machine's own LAN address, chosen by the rule the gateway finds its
 * home-network addresses by, where a computer elsewhere on the home network
 * would reach it. Every CI runner has one; a development box without one skips
 * the home-network half.
 */
function homeNetworkAddress(): string | null {
  return interfaceIdentities(networkInterfaces()).lan[0]?.address ?? null;
}

const LAN = homeNetworkAddress();
if (!LAN && process.env.CI)
  throw new Error("This CI runner has no private IPv4 address to test the home network with.");

async function setHomeNetwork(harness: SyntheticE2EHarness, home: "on" | "off"): Promise<void> {
  const response = await fetch(`${harness.gatewayUrl}/admin/remote-access`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${harness.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mcp: { home } }),
  });
  if (response.status !== 200)
    throw new Error(`PATCH /admin/remote-access returned ${response.status}`);
}

async function addNote(
  client: Awaited<ReturnType<typeof authorizeMcpClient>>["client"],
  text: string,
) {
  return client.callTool({
    name: "add_note",
    arguments: {
      id: randomUUID(),
      text,
      capturedAt: "2026-06-18T09:00:00.000Z",
      capturedTimeZoneId: "Europe/Paris",
      capturedUtcOffsetSeconds: 7200,
    },
  });
}

describe("MCP on this computer and the home network — spawned gateway", () => {
  let harness: SyntheticE2EHarness;
  let localPort = 0;

  beforeAll(async () => {
    localPort = await getFreePort();
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      agentBackend: "replay",
      extraGatewayEnv: { OMNESIS_LOCAL_MCP_PORT: String(localPort) },
    });
    await harness.start();
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("a local client signs in and calls a tool over plain HTTP on loopback, with no certificate", async () => {
    const plain = `http://localhost:${localPort}`;
    const metadata = await fetch(`${plain}/.well-known/oauth-protected-resource/mcp`);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      resource: `${plain}/mcp`,
      authorization_servers: [plain],
    });
    const authorized = await authorizeMcpClient(
      { ...harness, mcpUrl: plain },
      {
        principalName: "Fictional local editor",
        grantName: "Notes on this computer",
        credentialLabel: "Fictional local editor",
        capabilities: ["notes"],
        client: {
          redirectUrl: "http://localhost:48124/callback",
          clientName: "Fictional local editor",
        },
      },
    );
    try {
      expect((await authorized.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "add_note",
      ]);
      expect(
        (await addNote(authorized.client, "Fictional note over the loopback address.")).isError,
      ).not.toBe(true);
    } finally {
      await Promise.allSettled([authorized.client.close(), authorized.transport.close()]);
    }
  });

  test("the plain address serves only what an MCP client uses, and nothing off this machine", async () => {
    const plain = `http://localhost:${localPort}`;
    expect(
      (
        await fetch(`${plain}/admin/access`, {
          headers: { Authorization: `Bearer ${harness.apiKey}` },
        })
      ).status,
    ).toBe(404);
    expect((await fetch(`${plain}/health`)).status).toBe(404);
    const portal = await fetch(`${plain}/portal/settings/access`, { redirect: "manual" });
    expect(portal.status).toBe(302);
    expect(portal.headers.get("location")).toBe(`${harness.gatewayUrl}/portal/settings/access`);
    if (LAN) {
      const refused = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: LAN, port: localPort });
        socket.once("connect", () => {
          socket.destroy();
          resolve(false);
        });
        socket.once("error", () => resolve(true));
      });
      expect(refused).toBe(true);
    }
  });

  test.skipIf(!LAN)(
    "a home-network client can't sign in until the owner allows it, then can",
    async () => {
      const home = `https://${LAN}:${harness.gatewayPort}`;
      // Off: the endpoint answers as it always did, but names no issuer at this address.
      const challenge = await fetch(`${home}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(challenge.status).not.toBe(404);
      const offMetadata = await fetch(`${home}/.well-known/oauth-protected-resource/mcp`);
      if (offMetadata.status === 200)
        expect((await offMetadata.json()).resource).not.toBe(`${home}/mcp`);
      await expect(beginMcpAuthorization({ ...harness, mcpUrl: home })).rejects.toThrow();

      await setHomeNetwork(harness, "on");
      const onMetadata = await fetch(`${home}/.well-known/oauth-protected-resource/mcp`);
      expect(await onMetadata.json()).toMatchObject({
        resource: `${home}/mcp`,
        authorization_servers: [home],
      });
      const authorized = await authorizeMcpClient(
        { ...harness, mcpUrl: home },
        {
          principalName: "Fictional laptop agent",
          grantName: "Notes from the laptop",
          credentialLabel: "Fictional laptop agent",
          capabilities: ["notes"],
          client: {
            redirectUrl: "http://localhost:48125/callback",
            clientName: "Fictional laptop agent",
          },
        },
      );
      try {
        expect(
          (await addNote(authorized.client, "Fictional note from the home network.")).isError,
        ).not.toBe(true);
        // Off again: the resource it signed in to is no longer accepted.
        await setHomeNetwork(harness, "off");
        await expect(
          addNote(authorized.client, "Fictional note after home access ended."),
        ).rejects.toThrow();
      } finally {
        await Promise.allSettled([authorized.client.close(), authorized.transport.close()]);
      }
    },
  );
});

describe.skipIf(!LAN)("a home-network resource the configuration names — spawned gateway", () => {
  let harness: SyntheticE2EHarness;
  let home = "";

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      agentBackend: "replay",
      extraGatewayConfig: ({ gatewayUrl }) => {
        home = `https://${LAN}:${new URL(gatewayUrl).port}`;
        return { gateway: { publicBaseUrl: gatewayUrl, mcpResourceUrls: [`${home}/mcp`] } };
      },
    });
    await harness.start();
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("keeps signing in through the configured address, whatever the home-network choice", async () => {
    const authorized = await authorizeMcpClient(
      { ...harness, mcpUrl: home },
      {
        principalName: "Fictional configured agent",
        grantName: "Configured home address",
        credentialLabel: "Fictional configured agent",
        capabilities: ["notes"],
      },
    );
    try {
      for (const choice of ["off", "on", "off"] as const) {
        await setHomeNetwork(harness, choice);
        const metadata = await fetch(`${home}/.well-known/oauth-protected-resource/mcp`);
        expect(await metadata.json()).toMatchObject({
          resource: `${home}/mcp`,
          authorization_servers: [harness.gatewayUrl],
        });
        expect(
          (await addNote(authorized.client, `Fictional note with home ${choice}.`)).isError,
        ).not.toBe(true);
      }
    } finally {
      await Promise.allSettled([authorized.client.close(), authorized.transport.close()]);
    }
  });
});
