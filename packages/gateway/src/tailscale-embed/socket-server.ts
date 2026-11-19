// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway's private listener for its tailnet device. The helper program
 * forwards tailnet and public requests over an account-private Unix socket
 * or an authenticated TLS named pipe on Windows, naming the caller in one header. This listener is
 * the only place that header is believed: it decodes it, refuses public
 * requests outside the public paths, presents the request to the gateway as
 * the HTTPS request the caller made, and hands it to the same app the main
 * listener serves.
 */

import { createHash, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
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

export const TAILNET_TRANSPORT_HEADER = "x-omnesis-tailnet-transport";

/**
 * Where the private socket lives: inside the feature's own directory when the
 * path is short enough, otherwise in a per-config directory under the
 * runtime or temporary directory, created for this account only.
 */
export function tailnetSocketPath(
  featureDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (process.platform === "win32") {
    const tag = createHash("sha256").update(featureDir).digest("hex").slice(0, 12);
    return `\\\\.\\pipe\\omnesis-tailnet-${tag}-${randomBytes(16).toString("hex")}`;
  }
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
  token?: string,
): { ok: true; caller: TailnetCaller } | { ok: false; status: number } {
  if (token) {
    const credential = req.headers[TAILNET_TRANSPORT_HEADER];
    const count = req.rawHeaders.filter(
      (name, index) => index % 2 === 0 && name.toLowerCase() === TAILNET_TRANSPORT_HEADER,
    ).length;
    if (
      count !== 1 ||
      typeof credential !== "string" ||
      !/^[0-9a-f]{64}$/.test(credential) ||
      !timingSafeEqual(Buffer.from(credential), Buffer.from(token))
    )
      return { ok: false, status: 403 };
  }
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
  delete req.headers[TAILNET_TRANSPORT_HEADER];
  req.rawHeaders = req.rawHeaders.flatMap((name, index, headers) => {
    if (index % 2 !== 0) return [];
    const lower = name.toLowerCase();
    return lower === TAILNET_CALLER_HEADER || lower === TAILNET_TRANSPORT_HEADER
      ? []
      : [name, headers[index + 1]!];
  });
  recordTailnetCaller(req, caller);
  return { ok: true, caller };
}

export interface TailnetSocketServer {
  server: Server;
  path: string;
  /** Physical listener and connection closure, independent of path cleanup. */
  readonly closedConfirmed: boolean;
  /** Internal launch credentials; never expose them through status or logs. */
  transport?: { certificateSha256: string; token: string };
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
  /** Required on Windows; the helper pins this exact loaded certificate. */
  tls?: { cert: string; key: string };
  listener: RequestListener;
  upgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  onServer?: (server: Server) => void;
}): Promise<TailnetSocketServer> {
  const windows = process.platform === "win32";
  let acquired = false;
  if (windows && (!input.path.startsWith("\\\\.\\pipe\\") || !input.tls))
    throw new Error("The Windows Tailscale listener requires a TLS-authenticated named pipe");
  if (!windows) {
    const dir = join(input.path, "..");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
      throw new Error(`${dir} is not a directory owned by this account`);
    chmodSync(dir, 0o700);
    if (existsSync(input.path)) {
      if (lstatSync(input.path).isSocket()) rmSync(input.path, { force: true });
      else throw new Error(`${input.path} exists and is not a socket`);
    }
  }
  const transport = input.tls
    ? {
        certificateSha256: createHash("sha256")
          .update(new X509Certificate(input.tls.cert).raw)
          .digest("hex"),
        token: randomBytes(32).toString("hex"),
      }
    : undefined;
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    const admitted = admit(req, transport?.token);
    if (!admitted.ok) {
      res
        .writeHead(admitted.status, { "content-type": "text/plain; charset=utf-8" })
        .end(admitted.status === 404 ? "Not found" : "Bad request");
      return;
    }
    void input.listener(req, res);
  };
  const server = input.tls
    ? createHttpsServer({ ...input.tls, minVersion: "TLSv1.2" }, listener)
    : createServer(listener);
  const sockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      checkClosed?.();
    });
  });
  let checkClosed: (() => void) | undefined;
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const admitted = admit(req, transport?.token);
    const status = !admitted.ok ? admitted.status : admitted.caller.via === "public" ? 404 : 0;
    if (status !== 0 || !input.upgrade) {
      const code = status || 404;
      socket.end(
        `HTTP/1.1 ${code} ${code === 400 ? "Bad Request" : code === 403 ? "Forbidden" : "Not Found"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        () => socket.destroy(),
      );
      return;
    }
    input.upgrade(req, socket, head);
  });
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = KEEP_ALIVE_MS + 5_000;
  let closing: Promise<void> | undefined;
  let closedConfirmed = false;
  const close = (graceMs = 0): Promise<void> =>
    (closing ??= new Promise<void>((resolve, reject) => {
      let serverClosed = false;
      let settled = false;
      checkClosed = () => {
        if (settled || !serverClosed || sockets.size) return;
        settled = true;
        closedConfirmed = true;
        clearTimeout(timer);
        try {
          if (!windows && acquired) rmSync(input.path, { force: true });
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      server.close((error?: NodeJS.ErrnoException) => {
        if (
          error &&
          !(error.code === "ERR_SERVER_NOT_RUNNING" && !server.listening && sockets.size === 0)
        ) {
          settled = true;
          clearTimeout(timer);
          reject(
            Object.assign(
              new Error("Tailscale listener closure is unconfirmed", { cause: error }),
              { cleanupFailure: error },
            ),
          );
          return;
        }
        serverClosed = true;
        checkClosed?.();
      });
      server.closeIdleConnections();
      const timer = setTimeout(() => {
        for (const socket of sockets) {
          try {
            socket.destroy();
          } catch (error) {
            settled = true;
            reject(
              Object.assign(
                new Error("Tailscale connection closure is unconfirmed", { cause: error }),
                { cleanupFailure: error },
              ),
            );
          }
        }
        checkClosed?.();
      }, graceMs);
      timer.unref();
    }));

  try {
    input.onServer?.(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(input.path, () => {
        acquired = true;
        server.off("error", reject);
        resolve();
      });
    });
    if (!windows) chmodSync(input.path, 0o600);
    log.info(`Listening for the Tailscale helper on ${input.path}`);
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Tailscale listener startup failed during cleanup",
        { cause: cleanup },
      );
    }
    throw error;
  }
  return {
    server,
    path: input.path,
    get closedConfirmed() {
      return closedConfirmed;
    },
    ...(transport ? { transport } : {}),
    close,
  };
}
