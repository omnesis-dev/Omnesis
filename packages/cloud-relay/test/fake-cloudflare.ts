// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRecord {
  id: string;
  type: string;
  name: string;
  content?: string;
  comment?: string | null;
  proxied?: boolean;
  ttl?: number;
  data?: { flags: number; tag: string; value: string };
}

/**
 * An in-memory stand-in for Cloudflare's DNS records API, as a `fetch`. It answers only the
 * calls the broker makes, checks the bearer token and zone, and records every write.
 */
export function fakeCloudflare(options: { zoneId?: string; token?: string } = {}) {
  const zoneId = options.zoneId ?? "a".repeat(32);
  const token = options.token ?? "fixture-dns-edit-token";
  const records: FakeRecord[] = [];
  const writes: string[] = [];
  const fail = new Set<string>();
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `Bearer ${token}`)
      return new Response("{}", { status: 403 });
    // The API's own origin, or a loopback stand-in serving it at its root.
    const path = url.pathname.replace(/^\/client\/v4/, "");
    const prefix = `/zones/${zoneId}/dns_records`;
    if (!path.startsWith(prefix)) return new Response("{}", { status: 404 });
    const rest = path.slice(prefix.length);
    const reply = (result: unknown, info?: unknown) =>
      new Response(
        JSON.stringify({ success: true, result, ...(info ? { result_info: info } : {}) }),
        { headers: { "content-type": "application/json" } },
      );
    if (method === "GET" && rest === "") {
      if (fail.has("list")) return new Response("{}", { status: 500 });
      const type = url.searchParams.get("type");
      const name = url.searchParams.get("name");
      return reply(
        records.filter((record) => record.type === type && record.name === name),
        { total_pages: 1 },
      );
    }
    if (method === "POST" && rest === "") {
      const body = JSON.parse(String(init?.body)) as Omit<FakeRecord, "id">;
      if (fail.has(`create:${body.type}`)) return new Response("{}", { status: 500 });
      const record: FakeRecord = {
        ...body,
        id: randomBytes(16).toString("hex"),
        ...(body.type === "CAA"
          ? { content: `${body.data!.flags} ${body.data!.tag} "${body.data!.value}"` }
          : {}),
      };
      records.push(record);
      writes.push(`create ${record.type} ${record.name} ${record.content}`);
      return reply(record);
    }
    if (method === "DELETE" && /^\/[a-f0-9]{32}$/.test(rest)) {
      if (fail.has("delete")) return new Response("{}", { status: 500 });
      const index = records.findIndex((record) => record.id === rest.slice(1));
      if (index < 0) return new Response("{}", { status: 404 });
      const [record] = records.splice(index, 1);
      writes.push(`delete ${record!.type} ${record!.name} ${record!.content}`);
      return reply({ id: record!.id });
    }
    return new Response("{}", { status: 405 });
  };
  const add = (record: Omit<FakeRecord, "id">) => {
    const created = { ...record, id: randomBytes(16).toString("hex") };
    records.push(created);
    return created;
  };
  return { zoneId, token, records, writes, fail, fetch, add };
}

/** Serves a fake Cloudflare API on loopback, for a broker process that calls it over HTTP. */
export async function serveFakeCloudflare(cloudflare: ReturnType<typeof fakeCloudflare>) {
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => parts.push(chunk));
    req.on("end", () => {
      void cloudflare
        .fetch(`http://127.0.0.1${req.url}`, {
          method: req.method,
          headers: { authorization: req.headers.authorization ?? "" },
          body: parts.length ? Buffer.concat(parts).toString("utf8") : undefined,
        })
        .then(async (response) => {
          res.writeHead(response.status, { "content-type": "application/json" });
          res.end(await response.text());
        });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
