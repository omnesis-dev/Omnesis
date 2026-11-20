// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// A request body that stops arriving mid-upload is answered 408 (send it
// again), while a body that arrives whole and does not parse stays a 400.
// Driven over a real socket against the real gateway app: the distinction
// lives on Node's request object, which an in-process `app.request` lacks.
//
// The answers asserted are the gateway app's own, captured where the Node
// server hands each request to it. A client that stopped sending can no
// longer read a reply on that connection, and Node writes its own bare 400
// to a half-closed socket regardless; what the gateway decides is what its
// logs, its metrics and any proxy holding the other end of the request see.
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SCOPE_WRITE_ALL } from "@omnesis/types";
import { serve, type ServerType } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type Db } from "../db.js";
import { createServer as createGatewayServer } from "../server.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createToken } from "../data/repositories/TokenRepository.js";
import { REQUEST_BODY_INCOMPLETE } from "./incomplete-body.js";

let db: Db;
let testDir: string;
let gateway: ReturnType<typeof createGatewayServer>;
let server: ServerType;
let port: number;
let token: string;
let answers: { status: number; body: string }[];

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), "omnesis-incomplete-body-"));
  db = createDatabase(join(testDir, `gateway-${randomUUID()}.db`));
  const device = createDevice(db, { name: "Test phone", kind: "ios" });
  token = createToken(db, device.id, [SCOPE_WRITE_ALL]).token;
  gateway = createGatewayServer(db);
  answers = [];
  const fetch: typeof gateway.fetch = async (request, env) => {
    const response = await gateway.fetch(request, env);
    answers.push({ status: response.status, body: await response.clone().text() });
    return response;
  };
  port = await new Promise<number>((resolve) => {
    server = serve({ fetch, hostname: "127.0.0.1", port: 0 }, (info) => resolve(info.port));
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await gateway.close();
  db.close();
  rmSync(testDir, { recursive: true, force: true });
});

const body = JSON.stringify({
  tableName: "health_heart_rate",
  sourceId: "apple-health:local",
  records: [{ id: "sample-1", value: 61 }],
});

/**
 * Write one raw HTTP request, stop sending, wait for the connection to
 * close, and return the gateway app's answer to it.
 */
async function rawPost(head: string, payload: string): Promise<{ status: number; body: string }> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(head + payload);
      socket.end();
    });
    socket.resume();
    socket.on("error", reject);
    socket.on("close", () => resolve());
  });
  // The app may still be finishing its answer when the socket closes.
  for (let i = 0; i < 100 && answers.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(answers).toHaveLength(1);
  return answers[0]!;
}

function headers(extra: string): string {
  return (
    "POST /analytics/ingest HTTP/1.1\r\n" +
    "Host: 127.0.0.1\r\n" +
    "Content-Type: application/json\r\n" +
    `Authorization: Bearer ${token}\r\n` +
    extra +
    "\r\n"
  );
}

describe("request bodies cut off in transit", () => {
  test("a body shorter than its Content-Length is answered 408, not 400", async () => {
    const res = await rawPost(
      headers(`Content-Length: ${Buffer.byteLength(body)}\r\n`),
      body.slice(0, body.length / 2),
    );
    expect(res.status).toBe(408);
    expect(res.body).toContain(REQUEST_BODY_INCOMPLETE);
  });

  test("a chunked body that ends without its final chunk is answered 408", async () => {
    const part = body.slice(0, 20);
    const res = await rawPost(
      headers("Transfer-Encoding: chunked\r\n"),
      `${Buffer.byteLength(part).toString(16)}\r\n${part}\r\n`,
    );
    expect(res.status).toBe(408);
    expect(res.body).toContain(REQUEST_BODY_INCOMPLETE);
  });

  test("a complete body that is not JSON is still a 400", async () => {
    const malformed = '{"tableName": "health_heart_rate", "records": [}';
    const res = await rawPost(
      headers(`Content-Length: ${Buffer.byteLength(malformed)}\r\n`),
      malformed,
    );
    expect(res.status).toBe(400);
    expect(res.body).toContain("Malformed JSON in request body");
    expect(res.body).not.toContain(REQUEST_BODY_INCOMPLETE);
  });

  test("a complete body that is a truncated JSON document is still a 400", async () => {
    // Only the transport decides: a client that sent half a document as a
    // whole message sent malformed JSON, and retrying would repeat it.
    const half = body.slice(0, body.length / 2);
    const res = await rawPost(headers(`Content-Length: ${Buffer.byteLength(half)}\r\n`), half);
    expect(res.status).toBe(400);
    expect(res.body).not.toContain(REQUEST_BODY_INCOMPLETE);
  });

  test("a refusal thrown before the body is read is not mistaken for a cut-off body", async () => {
    const res = await rawPost(
      "POST /analytics/ingest HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n" +
        `Authorization: Bearer not-a-token\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`,
      body.slice(0, 10),
    );
    expect(res.status).toBe(401);
  });
});
