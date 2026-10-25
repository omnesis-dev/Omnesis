// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fetchAllowingSlowResponse } from "./slow-response-fetch.js";
import type { AddressInfo } from "node:net";

let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const delayMs = Number(req.headers["x-delay-ms"] ?? 0);
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            bytes: Buffer.concat(chunks).toString("hex"),
            contentType: req.headers["content-type"],
          }),
        );
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("fetchAllowingSlowResponse", () => {
  test("sends a binary body with its headers and reads the JSON answer", async () => {
    const res = await fetchAllowingSlowResponse(url, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array([1, 2, 255]),
    });
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ bytes: "0102ff", contentType: "audio/wav" });
  });

  test("leaves the deadline to the caller's signal", async () => {
    await expect(
      fetchAllowingSlowResponse(url, {
        headers: { "x-delay-ms": "500" },
        signal: AbortSignal.timeout(20),
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
