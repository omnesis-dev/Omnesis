// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { createServer, request } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { once } from "node:events";

/** Fault injection stays before the isolated pinned adapter; the opaque relay never sees HTTP. */
export async function lostAckProxy(destination: string) {
  const target = new URL(destination);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1")
    throw new Error("Fault proxy requires an isolated loopback adapter");
  const sockets = new Set<Socket>();
  const attempts: Array<{
    pendingPageId?: string;
    body: string;
    authorizationDigest: string;
    status?: number;
  }> = [];
  let collector: { deviceId: string; token: string } | undefined;
  let armed: { pageId: string; afterCommit: () => Promise<void> } | undefined;
  let failure: unknown;
  const upgradeStatuses: string[] = [];
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  const server = createServer((req, res) => {
    const capture = req.url === "/admin/devices" || req.url === "/documents/with-cursor";
    const chunks: Buffer[] = [];
    if (capture) req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const upstream = request(
      {
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        agent: false,
        headers: { ...req.headers, host: target.host },
      },
      (reply) => {
        const body = capture ? Buffer.concat(chunks).toString() : "";
        let parsed: Record<string, unknown> = {};
        if (body) parsed = JSON.parse(body);
        const attempt =
          req.url === "/documents/with-cursor"
            ? {
                pendingPageId: parsed.pendingPageId as string | undefined,
                body,
                authorizationDigest: createHash("sha256")
                  .update(req.headers.authorization ?? "")
                  .digest("hex"),
                status: reply.statusCode,
              }
            : undefined;
        if (attempt) attempts.push(attempt);
        if (
          attempt &&
          armed &&
          armed.pageId === attempt.pendingPageId &&
          reply.statusCode === 200
        ) {
          const drop = armed;
          armed = undefined;
          reply.resume();
          reply.once("end", () => {
            void drop
              .afterCommit()
              .catch((error) => {
                failure = error;
              })
              .finally(() => res.destroy());
          });
          reply.on("error", (error) => {
            failure = error;
            res.destroy();
          });
          return;
        }
        if (
          req.url === "/admin/devices" &&
          parsed.kind === "collector" &&
          parsed.name === "Synthetic E2E collector" &&
          reply.statusCode === 200
        ) {
          const registration: Buffer[] = [];
          reply.on("data", (chunk) => registration.push(Buffer.from(chunk)));
          reply.once("end", () => {
            const result = JSON.parse(Buffer.concat(registration).toString()) as {
              device: { id: string };
              token: string;
            };
            collector = { deviceId: result.device.id, token: result.token };
          });
        }
        res.writeHead(reply.statusCode!, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on("socket", track);
    upstream.on("error", () => res.destroy());
    req.on("aborted", () => upstream.destroy());
    res.once("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("connection", track);
  server.on("upgrade", (req, client, head) => {
    const upstream = connect({ host: target.hostname, port: Number(target.port) });
    track(upstream);
    upstream.once("data", (chunk) =>
      upgradeStatuses.push(chunk.toString("ascii", 0, 100).split("\r\n")[0]!),
    );
    const stop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.once("close", stop);
    upstream.once("close", stop);
    upstream.once("connect", () => {
      const headers = { ...req.headers, host: target.host };
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers)
          .flatMap(([key, values]) =>
            (Array.isArray(values) ? values : [String(values)]).map(
              (value) => `${key}: ${value}\r\n`,
            ),
          )
          .join("")}\r\n`,
      );
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    attempts,
    upgradeStatuses,
    collector: () => {
      if (!collector) throw new Error("Synthetic collector registration missing");
      return collector;
    },
    arm(pageId: string, afterCommit: () => Promise<void>) {
      armed = { pageId, afterCommit };
    },
    failure: () => failure,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
