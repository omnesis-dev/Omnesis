// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createSocket } from "node:dgram";

/** Actual DNS inside the disposable account-test container; no resolver preload enters the app. */
export async function startDesktopAccountDns(fixtureApi: string, port = 0) {
  const base = new URL(fixtureApi);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password)
    throw new Error("The fixture DNS API must be owned loopback HTTP");
  const socket = createSocket("udp4"),
    controller = new AbortController();
  const pending = new Set<Promise<void>>(),
    productionQueries = new Set<string>();
  let queries = 0;
  socket.on("message", (packet, peer) => {
    if (
      peer.address !== "127.0.0.1" ||
      packet.length < 17 ||
      packet.length > 512 ||
      ++queries > 10000
    )
      return;
    const task = (async () => {
      try {
        if (packet.readUInt16BE(4) !== 1) return;
        let offset = 12;
        const labels: string[] = [];
        while (offset < packet.length && packet[offset] !== 0) {
          const length = packet[offset++]!;
          if (length > 63 || offset + length >= packet.length) return;
          labels.push(packet.subarray(offset, offset + length).toString("ascii"));
          offset += length;
        }
        offset++;
        if (offset + 4 !== packet.length) return;
        const hostname = labels.join(".").toLowerCase(),
          type = packet.readUInt16BE(offset);
        if (hostname.length > 253 || packet.readUInt16BE(offset + 2) !== 1) return;
        const allowed =
          hostname === "localhost" ||
          hostname === "example.test" ||
          hostname.endsWith(".example.test");
        if (
          hostname === "omnesis.app" ||
          hostname.endsWith(".omnesis.app") ||
          hostname === "omnesis.dev" ||
          hostname.endsWith(".omnesis.dev")
        )
          productionQueries.add(hostname);
        const records: Buffer[] = [];
        if (allowed && type === 1) records.push(Buffer.from([127, 0, 0, 1]));
        if (allowed && (type === 16 || type === 257)) {
          const url = new URL(type === 16 ? "/txt" : "/caa", base);
          url.searchParams.set("name", hostname);
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) throw new Error("The fixture DNS API refused a query");
          const values: unknown = await response.json();
          if (!Array.isArray(values) || values.length > 32) return;
          for (const value of values) {
            if (type === 16) {
              if (
                !Array.isArray(value) ||
                value.some((entry) => typeof entry !== "string" || Buffer.byteLength(entry) > 255)
              )
                return;
              records.push(
                Buffer.concat(
                  value.map((entry: string) =>
                    Buffer.concat([Buffer.from([Buffer.byteLength(entry)]), Buffer.from(entry)]),
                  ),
                ),
              );
            } else {
              if (!value || typeof value !== "object") return;
              const item = value as Record<string, unknown>;
              const tag =
                typeof item.issue === "string"
                  ? "issue"
                  : typeof item.issuewild === "string"
                    ? "issuewild"
                    : null;
              if (!tag || typeof item[tag] !== "string" || Buffer.byteLength(item[tag]) > 1024)
                return;
              records.push(
                Buffer.concat([
                  Buffer.from([item.critical === 128 ? 128 : 0, tag.length]),
                  Buffer.from(tag),
                  Buffer.from(item[tag]),
                ]),
              );
            }
          }
        }
        const header = Buffer.alloc(12);
        header.writeUInt16BE(packet.readUInt16BE(0), 0);
        header.writeUInt16BE(allowed ? 0x8180 : 0x8183, 2);
        header.writeUInt16BE(1, 4);
        header.writeUInt16BE(records.length, 6);
        const answers = records.map((data) => {
          const record = Buffer.alloc(12);
          record.writeUInt16BE(0xc00c, 0);
          record.writeUInt16BE(type, 2);
          record.writeUInt16BE(1, 4);
          record.writeUInt32BE(1, 6);
          record.writeUInt16BE(data.length, 10);
          return Buffer.concat([record, data]);
        });
        const reply = Buffer.concat([header, packet.subarray(12), ...answers]);
        if (reply.length <= 4096 && !controller.signal.aborted)
          socket.send(reply, peer.port, peer.address);
      } catch {
        // Owned resolver cancellation or an invalid fixture query never falls back to public DNS.
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, "127.0.0.1", () => {
      socket.off("error", reject);
      resolve();
    });
  });
  return {
    port: socket.address().port,
    productionQueries,
    close: async () => {
      controller.abort();
      await Promise.allSettled(pending);
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    },
  };
}
