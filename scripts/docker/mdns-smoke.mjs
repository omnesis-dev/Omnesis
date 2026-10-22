#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Exercises Linux host-network discovery with a disposable encrypted gateway.
// Usage: node scripts/docker/mdns-smoke.mjs <locally-built gateway image>
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { request } from "node:https";
import { createServer } from "node:net";
import { promisify } from "node:util";
import makeMdns from "multicast-dns";

assert.equal(process.platform, "linux", "Host-network mDNS smoke requires Linux");
const image = process.argv[2];
assert(image && !image.startsWith("-"), "Provide a locally built gateway image");
const run = promisify(execFile);
const docker = async (...args) =>
  (await run("docker", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const suffix = randomBytes(6).toString("hex");
const name = `omnesis-mdns-check-${suffix}`;
const volume = `${name}-state`;
const hostname = `${name}.local`;
const instance = `${name}._omnesis._tcp.local`;
const records = new Map();
let mdns;
let queryTimer;
let volumeCreated = false;
let containerCreated = false;
const reserve = createServer();
await new Promise((resolve, reject) => {
  reserve.once("error", reject);
  reserve.listen(0, "0.0.0.0", resolve);
});
const port = reserve.address().port;
assert(port > 1024 && port !== 7600);
await new Promise((resolve) => reserve.close(resolve));
const mount = ["--mount", `type=volume,source=${volume},target=/var/lib/omnesis`];
const secretEnv = [
  "-e",
  "OMNESIS_SECRET_STORE=passphrase",
  "-e",
  "OMNESIS_KEYRING_PASSPHRASE_FILE=/var/lib/omnesis/keyring.pass",
];
const health = (address) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: address,
        port,
        path: "/health",
        rejectUnauthorized: false,
        timeout: 5000,
      },
      (res) => {
        const fingerprint = res.socket
          .getPeerCertificate()
          .fingerprint256?.replaceAll(":", "")
          .toLowerCase();
        res.resume();
        res.once("end", () =>
          res.statusCode === 200
            ? resolve(fingerprint)
            : reject(new Error(`Health HTTP ${res.statusCode}`)),
        );
      },
    );
    req.once("timeout", () => req.destroy(new Error("Health timed out")));
    req.once("error", reject);
    req.end();
  });
try {
  await docker("volume", "create", volume);
  volumeCreated = true;
  const config = { gateway: { mdns: { enabled: true, hostname, serviceName: name } } };
  await docker(
    "run",
    "--rm",
    ...mount,
    "--entrypoint",
    "node",
    image,
    "-e",
    `
    const fs = require('node:fs');
    fs.writeFileSync('/var/lib/omnesis/omnesis.json', ${JSON.stringify(JSON.stringify(config))}, {mode: 0o600});
    fs.writeFileSync('/var/lib/omnesis/keyring.pass', require('node:crypto').randomBytes(48).toString('hex'), {mode: 0o600});
  `,
  );
  await docker(
    "run",
    "--rm",
    ...mount,
    ...secretEnv,
    "--entrypoint",
    "omnesis",
    image,
    "keyring",
    "init",
    "--backend",
    "passphrase",
  );
  await docker(
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "host",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    ...mount,
    ...secretEnv,
    "-e",
    `OMNESIS_GATEWAY_PORT=${port}`,
    image,
  );
  containerCreated = true;
  const expectedAddresses = JSON.parse(
    await docker(
      "exec",
      name,
      "node",
      "--input-type=module",
      "-e",
      'import { realLanIpv4s } from "@omnesis/core"; process.stdout.write(JSON.stringify(realLanIpv4s()));',
    ),
  );
  assert(
    expectedAddresses.length,
    "This host has no real LAN IPv4 interface to test multicast discovery",
  );
  mdns = makeMdns({ interface: expectedAddresses[0], bind: "0.0.0.0" });
  let multicastFailure;
  mdns.on("error", (error) => {
    multicastFailure = error;
  });
  mdns.on("response", (packet) => {
    for (const record of [...(packet.answers ?? []), ...(packet.additionals ?? [])]) {
      if (record.ttl === 0) continue;
      if (
        record.name === instance ||
        record.name === hostname ||
        (record.type === "PTR" && record.data === instance)
      ) {
        records.set(
          `${record.type}:${record.name}:${record.type === "A" ? record.data : ""}`,
          record,
        );
      }
    }
  });
  const query = () =>
    mdns.query([
      { name: "_omnesis._tcp.local", type: "PTR" },
      { name: instance, type: "ANY" },
      { name: hostname, type: "A" },
    ]);
  queryTimer = setInterval(query, 1000);
  query();
  const deadline = Date.now() + 120_000;
  let verified = false;
  while (Date.now() < deadline) {
    if (multicastFailure) throw multicastFailure;
    const srv = [...records.values()].find((r) => r.type === "SRV" && r.name === instance);
    const txt = [...records.values()].find((r) => r.type === "TXT" && r.name === instance);
    const ptr = [...records.values()].find((r) => r.type === "PTR" && r.data === instance);
    const addresses = [...records.values()]
      .filter((r) => r.type === "A" && r.name === hostname)
      .map((r) => r.data);
    if (srv && txt && ptr && addresses.length) {
      assert.equal(srv.data.port, port);
      assert.equal(srv.data.target, hostname);
      assert(
        addresses.every((address) => expectedAddresses.includes(address)),
        "Discovery advertised a non-LAN address",
      );
      const entries = txt.data.map((entry) => entry.toString());
      assert(entries.includes("scheme=https"));
      const fingerprint = entries.find((entry) => entry.startsWith("fp="))?.slice(3);
      assert.match(fingerprint ?? "", /^[a-f0-9]{64}$/);
      for (const address of addresses) assert.equal(await health(address), fingerprint);
      verified = true;
      break;
    }
    const state = await docker("inspect", "--format", "{{.State.Running}}", name);
    assert.equal(state, "true", "Disposable gateway exited before discovery completed");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(verified, "No complete matching PTR/SRV/TXT/A multicast response within 120 seconds");
  process.stdout.write(
    "PASS: Docker host-network mDNS advertises reachable LAN addresses, port, and matching TLS fingerprint\n",
  );
} catch (error) {
  if (containerCreated)
    process.stderr.write(await docker("logs", "--tail", "80", name).catch(() => ""));
  throw error;
} finally {
  clearInterval(queryTimer);
  if (mdns) await new Promise((resolve) => mdns.destroy(resolve));
  if (containerCreated) await docker("rm", "-f", name);
  if (volumeCreated) await docker("volume", "rm", volume);
}
