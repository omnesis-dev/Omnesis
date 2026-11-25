// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

/** A bounded plaintext legacy image remains only in memory, exposed to its owned HTTP-range reader. */
export async function serveRestoreMemoryFile(
  image: Buffer,
  signal: AbortSignal,
): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  signal.throwIfAborted();
  if (!image.length || image.length > 64 * 1024 ** 2)
    throw new Error("The legacy analytics image exceeds the memory-only restore limit");
  const capability = `/${randomBytes(16).toString("hex")}/analytics.duckdb`;
  const server = createServer((request, response) => {
    const address = server.address();
    const origin = address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : "";
    let permitted = request.url === capability;
    // A closed local proxy form prevents native HTTP clients from falling back to inherited
    // proxy environment settings. It never forwards a request to another origin or path.
    if (!permitted && request.url?.startsWith("http://")) {
      try {
        const url = new URL(request.url);
        permitted =
          url.origin === origin &&
          url.pathname === capability &&
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password;
      } catch {
        permitted = false;
      }
    }
    if (!permitted || !["GET", "HEAD"].includes(request.method ?? "")) {
      response.writeHead(404).end();
      return;
    }
    const common = {
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-type": "application/octet-stream",
    };
    if (request.method === "HEAD") {
      response.writeHead(200, { ...common, "content-length": image.length }).end();
      return;
    }
    if (request.headers.range === undefined) {
      response.writeHead(200, { ...common, "content-length": image.length }).end(image);
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
    const start = Number(match?.[1]),
      end = match?.[2] ? Number(match[2]) : image.length - 1;
    if (
      !match ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= image.length ||
      end >= image.length
    ) {
      response.writeHead(416, { "content-range": `bytes */${image.length}` }).end();
      return;
    }
    response
      .writeHead(206, {
        ...common,
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${image.length}`,
      })
      .end(image.subarray(start, end + 1));
  });
  server.maxConnections = 8;
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  const abort = () => {
    server.closeAllConnections();
    server.close();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("The memory-only analytics reader is unavailable");
    return {
      url: `http://127.0.0.1:${address.port}${capability}`,
      async close() {
        signal.removeEventListener("abort", abort);
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", abort);
    server.closeAllConnections();
    server.close();
    throw error;
  }
}
