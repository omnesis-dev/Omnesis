// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import type { TailnetMachine } from "./tailnet-harness.js";

export interface JsonResponse {
  status: number;
  json: unknown;
  text: string;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** An HTTPS request trusting only the test authority. */
export function httpsJson(
  caCert: string,
  url: string,
  init: RequestOptions = {},
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = httpsRequest(
      url,
      {
        method: init.method ?? "GET",
        ca: caCert,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...init.headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: parse(text), text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * An HTTPS request from `machine` through its tailnet: a CONNECT through the
 * machine's proxy, then TLS to the name asked for, trusting the test
 * authority.
 */
export function fetchFrom(
  machine: TailnetMachine,
  caCert: string,
  url: string,
  init: RequestOptions = {},
): Promise<JsonResponse> {
  const target = new URL(url);
  const proxy = new URL(machine.proxyUrl);
  const port = target.port || "443";
  return new Promise((resolve, reject) => {
    const connect = httpRequest({
      host: proxy.hostname,
      port: proxy.port,
      method: "CONNECT",
      path: `${target.hostname}:${port}`,
      headers: { host: `${target.hostname}:${port}` },
    });
    connect.on("error", reject);
    connect.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${target.host} answered ${res.statusCode}`));
        return;
      }
      const body = init.body === undefined ? undefined : JSON.stringify(init.body);
      const req = httpsRequest(
        url,
        {
          method: init.method ?? "GET",
          headers: { ...(body ? { "content-type": "application/json" } : {}), ...init.headers },
          // No agent: Node then uses this connection instead of resolving
          // the tailnet name itself, which only the machine's proxy can.
          createConnection: () => tlsConnect({ socket, servername: target.hostname, ca: caCert }),
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (d: string) => (text += d));
          response.on("end", () => {
            socket.destroy();
            resolve({ status: response.statusCode ?? 0, json: parse(text), text });
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    connect.end();
  });
}
