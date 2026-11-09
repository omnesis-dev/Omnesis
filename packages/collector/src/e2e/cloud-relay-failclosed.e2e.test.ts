// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { startGatewayCloudTunnel } from "@omnesis/cloud-relay";
import { MultiCollectorHarness } from "./multi-collector-harness.js";
import type { AddressInfo } from "node:net";

test("corrupt saved relay settings keep the direct gateway available and cannot re-enable legacy environment exposure", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  let attempts = 0;
  const relay = createServer((_req, res) => {
    attempts++;
    res.writeHead(426);
    res.end();
  });
  relay.on("upgrade", (_req, socket) => {
    attempts++;
    socket.end("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n");
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  const gatewayId = randomUUID();
  const environment: NodeJS.ProcessEnv = {
    OMNESIS_CLOUD_RELAY_ENABLED: "1",
    OMNESIS_CLOUD_RELAY_URL: relayUrl,
    OMNESIS_CLOUD_RELAY_GATEWAY_ID: gatewayId,
    OMNESIS_PUBLIC_BASE_URL: "https://gateway.example.test",
  };
  const harness = new MultiCollectorHarness({ extraGatewayEnv: environment });
  const sessionFile = join(harness.gatewayConfigDir, "legacy-session.json");
  environment.OMNESIS_CLOUD_RELAY_SESSION_FILE = sessionFile;
  const file = join(harness.gatewayConfigDir, "cloud-relay/management.json");
  const malformed = "{invalid-private-management";
  let control: ReturnType<typeof startGatewayCloudTunnel>;
  try {
    await mkdir(join(harness.gatewayConfigDir, "cloud-relay"), { mode: 0o700 });
    await writeFile(file, malformed, { mode: 0o600 });
    await writeFile(sessionFile, JSON.stringify({ token: "isolated-routing-fixture" }), {
      mode: 0o600,
    });
    await harness.start();
    expect(await harness.json("/whoami")).toHaveProperty("deviceId");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(attempts).toBe(0);
    expect(await readFile(file, "utf8")).toBe(malformed);
    // Prove the exact isolated legacy environment can dial: its absence above is the fail-closed startup policy.
    control = startGatewayCloudTunnel(harness.gatewayUrl, environment);
    await vi.waitFor(() => expect(attempts).toBeGreaterThan(0), { timeout: 2000 });
  } finally {
    control?.stop();
    await harness.destroy();
    relay.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      relay.close((error) => (error ? reject(error) : resolve())),
    );
    vi.unstubAllEnvs();
  }
}, 30000);
