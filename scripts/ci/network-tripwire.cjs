// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Test jobs must never reach production Omnesis services. CI preloads this file
// into every Node process of a test job (NODE_OPTIONS=--require, which Node
// also runs in worker threads and which spawned gateways, CLIs and collectors
// inherit). Any lookup of omnesis.app or a name under it is refused as if the
// name did not exist, and is recorded in OMNESIS_NETWORK_TRIPWIRE_LOG so the
// job fails afterwards even when the code under test swallows the error.
// `scripts/ci/production-network.sh` installs it and checks the record.
"use strict";

// Plain require, not process.getBuiltinModule: the preload also runs in the
// runner's own Node for actions, which may be older than the repository's.
/* eslint-disable @typescript-eslint/no-require-imports */
const dns = require("node:dns");
const { appendFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
/* eslint-enable @typescript-eslint/no-require-imports */

const BLOCKED = ["omnesis.app"];

function blocked(host) {
  if (typeof host !== "string") return false;
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  return BLOCKED.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

function refuse(host, via) {
  const frames = (new Error().stack ?? "").split("\n").slice(3, 15).join("\n");
  const line =
    `[network-tripwire] blocked ${via}(${host}) pid=${process.pid}` +
    ` argv=${process.argv.slice(1).join(" ")}\n${frames}\n`;
  try {
    if (process.env.OMNESIS_NETWORK_TRIPWIRE_LOG)
      appendFileSync(process.env.OMNESIS_NETWORK_TRIPWIRE_LOG, line);
  } catch {
    // The record is best effort; the refusal below is not.
  }
  try {
    process.stderr.write(line);
  } catch {
    // A closed stderr must not turn the refusal into a different error.
  }
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${host} (blocked in CI test jobs)`), {
    code: "ENOTFOUND",
    errno: -3008,
    syscall: "getaddrinfo",
    hostname: host,
  });
}

function wrapCallback(target, name) {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function (host, ...rest) {
    if (!blocked(host)) return Reflect.apply(original, this, [host, ...rest]);
    const callback = rest.findLast((value) => typeof value === "function");
    const error = refuse(host, `dns.${name}`);
    if (callback) process.nextTick(callback, error);
    else throw error;
    return {};
  };
}

function wrapPromise(target, name, label) {
  const original = target[name];
  if (typeof original !== "function") return;
  target[name] = function (host, ...rest) {
    if (blocked(host)) return Promise.reject(refuse(host, label));
    return Reflect.apply(original, this, [host, ...rest]);
  };
}

const callbackNames = Object.keys(dns).filter((name) => name === "lookup" || /^resolve/.test(name));
for (const name of callbackNames) wrapCallback(dns, name);
for (const name of Object.getOwnPropertyNames(dns.Resolver.prototype))
  if (/^resolve/.test(name)) wrapCallback(dns.Resolver.prototype, name);
for (const name of Object.keys(dns.promises))
  if (name === "lookup" || /^resolve/.test(name))
    wrapPromise(dns.promises, name, `dns.promises.${name}`);
for (const name of Object.getOwnPropertyNames(dns.promises.Resolver.prototype))
  if (/^resolve/.test(name))
    wrapPromise(dns.promises.Resolver.prototype, name, `dns.promises.Resolver.${name}`);
// ESM `import { lookup } from "node:dns"` reads these bindings too.
syncBuiltinESMExports();
