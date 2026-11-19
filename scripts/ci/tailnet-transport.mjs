// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Run with node --import tsx. No tailnet, credentials or external service is used.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  spawnOwnedChildProcess,
  ownedProcessCleanupReceipt,
} from "../../packages/core/src/index.ts";
import { generateSelfSigned } from "../../packages/gateway/src/tls.ts";
import {
  startTailnetSocketServer,
  tailnetSocketPath,
} from "../../packages/gateway/src/tailscale-embed/socket-server.ts";
import { tailnetCallerOf } from "../../packages/gateway/src/tailscale-embed/caller.ts";
import { runCheckCommand } from "../lib/check-process.mjs";

const scratch = await mkdtemp(join(tmpdir(), "omnesis-tailnet-transport-"));
const binary = join(scratch, `proxy-fixture${process.platform === "win32" ? ".exe" : ""}`);
const children = [];
let socket;
let websocketServer;
let retainInputs = false;
let requests = 0;
let verified = false;
const releaseStream = Promise.withResolvers();

async function startProxy(token, pin) {
  const owner = spawnOwnedChildProcess(binary, ["-socket", socket.path, "-pin", pin], {
    env: { ...process.env, OMNESIS_TAILNET_IPC_TOKEN: token },
  });
  children.push(owner);
  await owner.ready;
  const ready = Promise.withResolvers();
  let output = "";
  const data = (bytes) => {
    output += bytes.toString();
    if (output.length > 2048) {
      ready.reject(new Error("Proxy readiness exceeded its bound"));
      return;
    }
    const end = output.indexOf("\n");
    if (end < 0) return;
    try {
      const value = JSON.parse(output.slice(0, end));
      assert.match(value.address, /^127\.0\.0\.1:\d+$/);
      ready.resolve(`http://${value.address}`);
    } catch {
      ready.reject(new Error("Invalid proxy readiness"));
    }
  };
  owner.child.stdout.on("data", data);
  void owner.joined.then(
    () => ready.reject(new Error("Proxy closed before readiness")),
    ready.reject,
  );
  const timer = setTimeout(() => ready.reject(new Error("Proxy readiness timed out")), 10_000);
  try {
    return await ready.promise;
  } finally {
    clearTimeout(timer);
    owner.child.stdout.off("data", data);
  }
}

async function websocketRoundTrip(origin) {
  const client = new WebSocket(`${origin.replace("http:", "ws:")}/ws`);
  const result = Promise.withResolvers();
  const closed = Promise.withResolvers();
  client.once("close", () => closed.resolve());
  client.once("error", result.reject);
  client.once("open", () => client.send("invented websocket probe"));
  client.once("message", (bytes) => {
    try {
      assert.equal(bytes.toString(), "invented websocket probe");
      result.resolve();
    } catch (error) {
      result.reject(error);
    }
  });
  const timer = setTimeout(
    () => result.reject(new Error("WebSocket round trip timed out")),
    10_000,
  );
  try {
    await result.promise;
  } finally {
    clearTimeout(timer);
    client.terminate();
    await closed.promise;
  }
}

try {
  assert.equal(
    await runCheckCommand("go", ["build", "-p", "2", "-o", binary, "./test/proxy-fixture"], {
      cwd: resolve("packages/tailnet-helper"),
      env: { ...process.env, GOMAXPROCS: "2", GOFLAGS: "-mod=readonly" },
    }),
    0,
  );
  const tls = await generateSelfSigned();
  websocketServer = new WebSocketServer({ noServer: true });
  const inspect = (req) => {
    requests++;
    assert.equal(
      req.rawHeaders.some((value) => value.toLowerCase().startsWith("x-omnesis-tailnet")),
      false,
    );
    assert.equal(req.headers["x-omnesis-tailnet-transport"], undefined);
    assert.equal(tailnetCallerOf(req)?.peer?.sameOwner, true);
  };
  socket = await startTailnetSocketServer({
    path: tailnetSocketPath(scratch),
    tls,
    listener: async (req, res) => {
      inspect(req);
      if (req.url.endsWith("/sse")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        await releaseStream.promise;
        res.end("data: second\n\n");
      } else res.end("invented HTTP response");
    },
    upgrade: (req, stream, head) => {
      inspect(req);
      websocketServer.handleUpgrade(req, stream, head, (client) => {
        client.on("message", (bytes) => client.send(bytes));
      });
    },
  });
  const endpoint = socket.transport;
  const origin = await startProxy(endpoint.token, endpoint.certificateSha256);
  const response = await fetch(`${origin}/http`, {
    headers: { "x-omnesis-tailnet-transport": "spoofed" },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "invented HTTP response");
  const streamed = await fetch(`${origin}/sse`, { signal: AbortSignal.timeout(10_000) });
  const reader = streamed.body.getReader();
  let first = "";
  while (!first.includes("data: first")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    first += new TextDecoder().decode(chunk.value);
  }
  releaseStream.resolve();
  let rest = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    rest += new TextDecoder().decode(chunk.value);
  }
  assert.match(first + rest, /data: second/);
  await websocketRoundTrip(origin);
  const accepted = requests;
  assert.equal(accepted, 3);
  const wrongToken = await startProxy("0".repeat(64), endpoint.certificateSha256);
  assert.equal(
    (await fetch(`${wrongToken}/denied`, { signal: AbortSignal.timeout(10_000) })).status,
    403,
  );
  const wrongServer = await startProxy(endpoint.token, "0".repeat(64));
  assert.equal(
    (await fetch(`${wrongServer}/wrong-pin`, { signal: AbortSignal.timeout(10_000) })).status,
    502,
  );
  assert.equal(requests, accepted);
  verified = true;
} catch (error) {
  retainInputs ||= ownedProcessCleanupReceipt(error) !== undefined;
  process.exitCode = 1;
  process.stderr.write(
    `Private transport check failed: ${error instanceof Error ? error.message : "unknown failure"}\n`,
  );
} finally {
  releaseStream.resolve();
  const results = await Promise.allSettled([
    ...children.map((owner) => owner.stop()),
    ...(socket ? [socket.close()] : []),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      retainInputs ||= ownedProcessCleanupReceipt(result.reason) !== undefined;
      process.exitCode = 1;
    }
  }
  // Retain before awaiting any further proof: a rejected owner must never fall
  // through an otherwise idle Node event loop.
  if (retainInputs) setInterval(() => {}, 60_000);
  if (websocketServer) await new Promise((done) => websocketServer.close(done));
  if (retainInputs) {
    process.stderr.write(
      "Private transport cleanup is unconfirmed; inputs and owner are retained for review.\n",
    );
    process.exitCode = 1;
  } else await rm(scratch, { recursive: true, force: true });
}

if (verified && process.exitCode !== 1 && !retainInputs) {
  process.stdout.write(
    `Private Go-to-Node transport passed: ${process.platform} ${process.arch}; HTTP, incremental SSE, WebSocket, spoof replacement, wrong token, wrong server pin.\n`,
  );
}
