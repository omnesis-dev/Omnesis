// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The DNS broker on Node, for local deployments and tests: the same core the Worker runs, with
 * a private file as its store and a plain HTTP(S) listener. The registry and lease journal stay
 * on whatever host runs this, never on the relay's.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { open } from "node:fs/promises";
import { z } from "zod";
import { LoginAdmission, type LoginLimits } from "./admission.js";
import { savePrivateJson } from "./google-credentials.js";
import { RelayError } from "./tunnels.js";
import type { BrokerStore, DnsBroker } from "./dns-broker-core.js";
import type { Socket } from "node:net";

const MAX_STORE_BYTES = 64 * 1024 * 1024;

/** The whole store in one private file, replaced atomically on every change. */
export class FileBrokerStore implements BrokerStore {
  private constructor(
    private readonly file: string,
    private values: Map<string, unknown>,
  ) {}
  static async open(file: string): Promise<FileBrokerStore> {
    let text: string;
    try {
      const handle = await open(file, "r");
      try {
        if ((await handle.stat()).size > MAX_STORE_BYTES)
          throw new Error("The DNS broker registry is too large");
        text = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return new FileBrokerStore(file, new Map());
      throw error;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
    } catch {
      throw new Error("Invalid DNS broker registry");
    }
    return new FileBrokerStore(file, new Map(Object.entries(parsed)));
  }
  async get(key: string): Promise<unknown> {
    return structuredClone(this.values.get(key));
  }
  async put(key: string, value: unknown): Promise<void> {
    const next = new Map(this.values).set(key, structuredClone(value));
    await savePrivateJson(this.file, Object.fromEntries(next));
    this.values = next;
  }
  async delete(key: string): Promise<void> {
    if (!this.values.has(key)) return;
    const next = new Map(this.values);
    next.delete(key);
    await savePrivateJson(this.file, Object.fromEntries(next));
    this.values = next;
  }
  async list(prefix: string): Promise<Map<string, unknown>> {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key, structuredClone(value)]),
    );
  }
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += Buffer.byteLength(chunk);
    if (size > 1_048_576) throw new RelayError(413, "DNS broker request is too large");
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

/**
 * Serves the broker's fetch handler over Node HTTP(S). `legacy` answers the receipt-authorized
 * version 1 routes when a recovery policy is configured.
 */
export function createDnsBrokerServer(options: {
  broker: Pick<DnsBroker, "handle" | "expire">;
  tls?: { cert: string; key: string };
  loginLimits?: LoginLimits;
  legacy?: Server;
}) {
  const admission = LoginAdmission.fromLimits(options.loginLimits);
  const server = options.tls ? createHttpsServer(options.tls) : createServer();
  server.requestTimeout = 15_000;
  server.headersTimeout = 15_000;
  server.maxConnections = 64;
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  });
  server.on("request", (req, res) => {
    const path = req.url!.split("?")[0]!;
    if (options.legacy && (path === "/healthz" || path.startsWith("/_dns/v1/"))) {
      options.legacy.emit("request", req, res);
      return;
    }
    void admission
      .run(async () => {
        const payload = req.method === "GET" || req.method === "HEAD" ? undefined : await body(req);
        const response = await options.broker.handle(
          new Request(new URL(req.url!, "http://dns-broker.invalid"), {
            method: req.method,
            headers: {
              "content-type": req.headers["content-type"] ?? "",
              authorization: req.headers.authorization ?? "",
            },
            body: payload && new Uint8Array(payload),
          }),
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      }, req)
      .catch((error: unknown) => {
        res.shouldKeepAlive = false;
        if (!res.headersSent)
          res.writeHead(error instanceof RelayError ? error.status : 400, {
            "cache-control": "no-store",
          });
        res.end(undefined, () => req.destroy());
      });
  });
  // Expired leases are removed even while no gateway asks for anything.
  const timer = setInterval(() => {
    void options.broker.expire().catch(() => {});
  }, 30_000);
  timer.unref();
  let closing: Promise<void> | undefined;
  return {
    server,
    close(): Promise<void> {
      return (closing ??= (async () => {
        clearInterval(timer);
        const stopped = server.listening
          ? new Promise<Error | undefined>((resolve) => server.close((error) => resolve(error)))
          : Promise.resolve(undefined);
        for (const socket of sockets) socket.destroy();
        const error = await stopped;
        if (error) throw error;
      })());
    },
  };
}
