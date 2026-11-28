// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer } from "node:http";
import { linkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.OMNESIS_GUI_FIXTURE_ROOT;
if (!root) throw new Error("An owned fixture directory is required");
const sockets = new Set();
const requests = [];
const held = new Set();
let routes = {};
const reply = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};
const server = createServer(async (request, response) => {
  if (request.headers.authorization !== "Bearer gui-fixture-token") {
    reply(response, 401, {});
    return;
  }
  let bytes = "";
  for await (const chunk of request) {
    bytes += chunk;
    if (bytes.length > 65536) {
      reply(response, 413, {});
      return;
    }
  }
  const body = bytes ? JSON.parse(bytes) : null;
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  if (path === "/fixture-config" && request.method === "POST") {
    routes = body.routes;
    reply(response, 200, {});
    return;
  }
  if (path === "/fixture-release" && request.method === "POST") {
    for (const release of held) release();
    held.clear();
    reply(response, 200, {});
    return;
  }
  if (path === "/fixture-context-status") {
    reply(response, 200, { requests });
    return;
  }
  requests.push({ method: request.method, path, body });
  const route = routes[`${request.method} ${path}`];
  if (!route) {
    reply(response, 404, { error: "No scripted route" });
    return;
  }
  if (route.hold) await new Promise((resolve) => held.add(resolve));
  reply(response, route.status ?? 200, route.body);
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
server.listen(0, "127.0.0.1", () => {
  const pending = join(root, "endpoint.pending");
  writeFileSync(pending, JSON.stringify({ port: server.address().port }), {
    mode: 0o600,
    flag: "wx",
  });
  // Publish complete bytes atomically, without replacing an existing endpoint.
  linkSync(pending, join(root, "endpoint.json"));
  unlinkSync(pending);
});
process.on("SIGTERM", () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
});
