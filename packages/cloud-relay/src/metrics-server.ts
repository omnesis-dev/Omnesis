// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

/** Private loopback listener only; the public control and TLS data listeners never serve metrics. */
export async function startRelayMetricsServer(
  port: number,
  render: () => string,
): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/metrics") {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const body = render();
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(503);
      res.end();
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
