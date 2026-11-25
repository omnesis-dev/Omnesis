// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { join } from "node:path";
import { readTokenFile } from "@omnesis/core";
import { readDesktopRuntime } from "./runtime-state.js";
import type { DesktopProfile } from "./environment.js";

export interface DesktopConnection {
  url: string;
  token: string;
  certificatePEM: string;
}

export async function readDesktopConnection(profile: DesktopProfile): Promise<DesktopConnection> {
  const runtime = await readDesktopRuntime(profile);
  const token = readTokenFile(profile.configDir);
  if (!runtime || !token) throw new Error("The private library is still starting");
  return {
    url: `https://localhost:${runtime.port}`,
    token,
    certificatePEM: await readFile(join(profile.configDir, "tls", "cert.pem"), "utf8"),
  };
}

/** Only the app-owned loopback endpoint receives this installation's credential. */
export async function requestDesktopGateway(
  profile: DesktopProfile,
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    signal?: AbortSignal;
  } = {},
): Promise<unknown> {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    /[\r\n]/.test(path)
  ) {
    throw new Error("Invalid local gateway request path");
  }
  const runtime = await readDesktopRuntime(profile);
  if (!runtime) throw new Error("The private library is still starting");
  const ca = await readFile(join(profile.configDir, "tls", "cert.pem"), "utf8");
  const token = readTokenFile(profile.configDir);
  if (!token && path !== "/health") throw new Error("The private library is still starting");
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(15_000),
  ]);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        servername: "localhost",
        port: runtime.port,
        path,
        method: options.method ?? "GET",
        ca,
        rejectUnauthorized: true,
        signal,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("error", reject);
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) {
            req.destroy(new Error("The local gateway response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (
            response.statusCode === undefined ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            reject(new Error("The local gateway refused the request"));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("The local gateway returned an invalid response"));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
