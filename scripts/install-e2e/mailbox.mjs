#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The mailbox two jobs of the tailnet lane coordinate through.
 *
 *   node scripts/install-e2e/mailbox.mjs serve --host <addr> --port <port>
 *   node scripts/install-e2e/mailbox.mjs put  --url <base> --key <k> [--value <v> | --value-file <f>]
 *   node scripts/install-e2e/mailbox.mjs get  --url <base> --key <k>
 *   node scripts/install-e2e/mailbox.mjs wait --url <base> --key <k> --timeout <seconds> [--gone-after <seconds>]
 *
 * The gateway job serves it on its tailnet address; the collector job reads
 * the join URL, fingerprint and pairing code from it and both sides post
 * phase markers. Either side posts `abort` when it fails, and every `wait`
 * returns at once when that key appears, so a failure on one machine ends
 * the other's wait instead of running it to its timeout.
 *
 * The server keeps values in memory and binds only the address it is given.
 * The tailnet the lane runs on admits only the run's own nodes; that boundary,
 * not the mailbox, is the access control.
 *
 * A mailbox lives as long as the gateway job, so one that answered once and
 * then stops answering for `--gone-after` seconds belongs to a job that has
 * ended; waiting on it until the timeout would only delay the verdict.
 *
 * Exit codes for `get` and `wait`: 0 with the value on stdout, 2 when the
 * other side aborted (its reason on stderr), 3 when the key never appeared,
 * 4 when the mailbox went away.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ABORT_KEY = "abort";
export const EXIT_ABORTED = 2;
export const EXIT_TIMEOUT = 3;
export const EXIT_GONE = 4;
const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_BODY = 64 * 1024;

export function createMailboxServer() {
  const values = new Map();
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mailbox");
    const match = /^\/v1\/([^/]+)$/.exec(url.pathname);
    const key = match ? decodeURIComponent(match[1]) : null;
    if (!key || !KEY.test(key)) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET") {
      if (!values.has(key)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" }).end(values.get(key));
      return;
    }
    if (req.method === "PUT") {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          res.writeHead(413).end();
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (size > MAX_BODY) return;
        values.set(key, Buffer.concat(chunks).toString("utf8"));
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(405).end();
  });
}

async function request(base, key, init = {}) {
  const url = `${base.replace(/\/$/, "")}/v1/${encodeURIComponent(key)}`;
  return fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
}

export async function put(base, key, value) {
  if (!KEY.test(key)) throw new Error(`invalid key ${key}`);
  const res = await request(base, key, { method: "PUT", body: value });
  if (res.status !== 204) throw new Error(`put ${key}: HTTP ${res.status}`);
}

/** The value, or null when the key is absent. Throws when the mailbox is unreachable. */
export async function get(base, key) {
  const res = await request(base, key);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`get ${key}: HTTP ${res.status}`);
  return res.text();
}

/**
 * Poll until `key` appears, the other side aborts, the mailbox goes away, or
 * the deadline passes. A mailbox never reached yet is retried: the other job
 * may not be up.
 */
export async function wait(
  base,
  key,
  { timeoutMs, goneAfterMs = Infinity, intervalMs = 2000, now = Date.now, sleep } = {},
) {
  const pause = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;
  let lastReached = null;
  for (;;) {
    try {
      if (key !== ABORT_KEY) {
        const reason = await get(base, ABORT_KEY);
        if (reason !== null) return { status: "aborted", value: reason };
      }
      const value = await get(base, key);
      lastReached = now();
      if (value !== null) return { status: "ok", value };
    } catch {
      if (lastReached !== null && now() - lastReached >= goneAfterMs)
        return { status: "gone", value: null };
    }
    if (now() >= deadline) return { status: "timeout", value: null };
    await pause(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    flags[arg.slice(2)] = value;
  }
  return flags;
}

async function main([command, ...rest]) {
  const flags = parseFlags(rest);
  if (command === "serve") {
    const server = createMailboxServer();
    const port = Number(flags.port ?? 0);
    await new Promise((ok, fail) => {
      server.once("error", fail);
      server.listen(port, flags.host ?? "127.0.0.1", ok);
    });
    process.stdout.write(`mailbox listening on port ${server.address().port}\n`);
    return;
  }
  if (!flags.url || !flags.key) throw new Error(`${command} needs --url and --key`);
  if (command === "put") {
    const value = flags["value-file"]
      ? readFileSync(flags["value-file"], "utf8")
      : (flags.value ?? "");
    await put(flags.url, flags.key, value);
    return;
  }
  if (command === "get") {
    const value = await get(flags.url, flags.key);
    if (value === null) process.exit(EXIT_TIMEOUT);
    process.stdout.write(value);
    return;
  }
  if (command === "wait") {
    const timeoutMs = Number(flags.timeout ?? 600) * 1000;
    const goneAfterMs = flags["gone-after"] ? Number(flags["gone-after"]) * 1000 : Infinity;
    const result = await wait(flags.url, flags.key, { timeoutMs, goneAfterMs });
    if (result.status === "ok") {
      process.stdout.write(result.value);
      return;
    }
    if (result.status === "aborted") {
      process.stderr.write(`mailbox: the other job aborted: ${result.value}\n`);
      process.exit(EXIT_ABORTED);
    }
    if (result.status === "gone") {
      process.stderr.write(
        `mailbox: the mailbox stopped answering while waiting for ${flags.key}\n`,
      );
      process.exit(EXIT_GONE);
    }
    process.stderr.write(`mailbox: ${flags.key} did not arrive within ${flags.timeout ?? 600}s\n`);
    process.exit(EXIT_TIMEOUT);
  }
  throw new Error("usage: mailbox.mjs serve|put|get|wait …");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`mailbox: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
