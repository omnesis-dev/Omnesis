// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway's private listener for its tailnet device. The helper program
 * forwards every tailnet and public request here over a Unix socket that only
 * this account can open, naming the caller in one header. This listener is
 * the only place that header is believed: it decodes it, refuses public
 * requests outside the public paths, presents the request to the gateway as
 * the HTTPS request the caller made, and hands it to the same app the main
 * listener serves.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@omnesis/core";
import {
  decodeTailnetCaller,
  publicPathAllowed,
  recordTailnetCaller,
  TAILNET_CALLER_HEADER,
  type TailnetCaller,
} from "./caller.js";
import type { Duplex } from "node:stream";

const log = createLogger("gateway:tailscale").child("socket");

/** Unix socket paths are limited to a little over 100 bytes on common systems. */
const MAX_SOCKET_PATH = 100;
/**
 * How long an idle connection from the helper stays open. Longer than the
 * helper keeps idle connections (90 s), so the helper never sends a request
 * on a connection this side has just closed.
 */
const KEEP_ALIVE_MS = 120_000;

/**
 * Where the private socket lives: inside the feature's own directory when the
 * path is short enough, otherwise in a per-config directory under the
 * runtime or temporary directory, created for this account only.
 */
export function tailnetSocketPath(
  featureDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const preferred = join(featureDir, "gateway.sock");
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH) return preferred;
  const tag = createHash("sha256").update(featureDir).digest("hex").slice(0, 12);
  const base =
    env.XDG_RUNTIME_DIR && existsSync(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : tmpdir();
  return join(base, `omnesis-ts-${tag}`, "gateway.sock");
}

/** The app's Node request listener; it answers through `res` and may return a promise. */
export type RequestListener = (req: IncomingMessage, res: ServerResponse) => unknown;

/** Decode and record the caller, and rewrite the request into its HTTPS form. */
function admit(
  req: IncomingMessage,
): { ok: true; caller: TailnetCaller } | { ok: false; status: number } {
  const raw = req.headers[TAILNET_CALLER_HEADER];
  const caller = decodeTailnetCaller(Array.isArray(raw) ? undefined : raw);
  if (!caller) return { ok: false, status: 400 };
  const path = (req.url ?? "/").split("?")[0]!;
  if (caller.via === "public" && !publicPathAllowed(path)) return { ok: false, status: 404 };
  const host = req.headers.host;
  if (!host || !/^[A-Za-z0-9.:[\]-]+$/.test(host) || !(req.url ?? "").startsWith("/")) {
    return { ok: false, status: 400 };
  }
  // The caller spoke HTTPS to the helper; the gateway builds absolute URLs
  // (OAuth metadata, redirects) from what it sees, so it must see that.
  req.url = `https://${host}${req.url}`;
  delete req.headers[TAILNET_CALLER_HEADER];
  recordTailnetCaller(req, caller);
  return { ok: true, caller };
}

export interface TailnetSocketServer {
  server: Server;
  path: string;
  /** Stop accepting, give requests in flight up to `graceMs`, then cut the rest. */
  close(graceMs?: number): Promise<void>;
}

/**
 * Listen on `path` and serve `listener` (the app's Node request listener).
 * Admitted WebSocket upgrades from the tailnet go to `upgrade`; nothing else
 * sees an upgrade, and no WebSocket route is public. `onServer` runs before
 * listening, for drain tracking as on the main listener.
 */
export async function startTailnetSocketServer(input: {
  path: string;
  listener: RequestListener;
  upgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  onServer?: (server: Server) => void;
}): Promise<TailnetSocketServer> {
  const dir = join(input.path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The directory may sit in a shared temporary directory: it must be a real
  // directory of this account's, or another account could reach the socket.
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`${dir} is not a directory owned by this account`);
  }
  chmodSync(dir, 0o700);
  if (existsSync(input.path)) {
    // A socket left by a gateway that did not shut down cleanly.
    if (lstatSync(input.path).isSocket()) rmSync(input.path, { force: true });
    else throw new Error(`${input.path} exists and is not a socket`);
  }

  const server = createServer((req, res) => {
    const admitted = admit(req);
    if (!admitted.ok) {
      res
        .writeHead(admitted.status, { "content-type": "text/plain; charset=utf-8" })
        .end(admitted.status === 404 ? "Not found" : "Bad request");
      return;
    }
    void input.listener(req, res);
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const admitted = admit(req);
    const status = !admitted.ok ? admitted.status : admitted.caller.via === "public" ? 404 : 0;
    if (status !== 0 || !input.upgrade) {
      const code = status || 404;
      socket.end(
        `HTTP/1.1 ${code} ${code === 400 ? "Bad Request" : "Not Found"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      socket.destroy();
      return;
    }
    input.upgrade(req, socket, head);
  });
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = KEEP_ALIVE_MS + 5_000;
  input.onServer?.(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(input.path, 0o600);
  log.info(`Listening for the Tailscale helper on ${input.path}`);
  return {
    server,
    path: input.path,
    close: (graceMs = 0) =>
      new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          server.closeAllConnections();
          rmSync(input.path, { force: true });
          resolve();
        };
        server.close(finish);
        server.closeIdleConnections();
        const timer = setTimeout(finish, graceMs);
        timer.unref();
      }),
  };
}
