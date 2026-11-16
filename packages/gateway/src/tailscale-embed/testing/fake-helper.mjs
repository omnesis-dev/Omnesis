#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A stand-in for the Tailscale helper program that speaks the same protocol
 * from a scripted scenario, for gateway tests and portal screenshots. It never
 * touches a network. Point OMNESIS_TAILSCALE_HELPER at this file.
 *
 * The story is the first line of `fake-scenario` in its -state-dir (the
 * gateway passes the helper only an allowlisted environment), or else
 * OMNESIS_FAKE_TAILNET_SCENARIO, where a test spawns it directly:
 *   needs-sign-in     waits for sign-in until it receives "login" twice
 *   connected         signed in, Tailscale certificate ready
 *   https-disabled    signed in, the tailnet has HTTPS certificates off
 *   certificate-pending  signed in, Tailscale still issuing the certificate
 *   needs-approval    signed in, waiting for a tailnet admin to approve
 *   public-needs-enable  like connected, but the public address needs allowing
 * The public address follows the gateway's configure commands.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`-${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
function scenarioFile() {
  try {
    return readFileSync(join(flag("state-dir") ?? "", "fake-scenario"), "utf8")
      .split("\n")[0]
      .trim();
  } catch {
    return undefined;
  }
}
const scenario = scenarioFile() || process.env.OMNESIS_FAKE_TAILNET_SCENARIO || "connected";
const hostname = flag("hostname") ?? "omnesis";
const dnsName = `${hostname}.example-net.ts.net`;

let signedIn = !["needs-sign-in"].includes(scenario);
let loginCount = 0;
let wantPublic = false;

function status() {
  const base = {
    type: "status",
    protocol: Number(process.env.OMNESIS_FAKE_TAILNET_PROTOCOL ?? 1),
    certificate: { source: "gateway", reason: "pending" },
    public: { state: "off" },
  };
  if (!signedIn) {
    return {
      ...base,
      backend: "needs-login",
      loginUrl: `https://login.tailscale.com/a/fake${loginCount}`,
    };
  }
  if (scenario === "needs-approval") return { ...base, backend: "needs-approval" };
  const trusted = scenario !== "https-disabled" && scenario !== "certificate-pending";
  const certificate = trusted
    ? { source: "tailscale" }
    : {
        source: "gateway",
        reason: scenario === "certificate-pending" ? "pending" : "https-disabled",
      };
  let pub = { state: "off" };
  if (wantPublic) {
    pub = !trusted
      ? { state: "unavailable", reason: "https-disabled" }
      : scenario === "public-needs-enable"
        ? {
            state: "needs-enable",
            enableUrl: "https://login.tailscale.com/f/funnel?node=fake",
            reason: 'Funnel not available; "funnel" node attribute not set.',
          }
        : { state: "on", url: `https://${dnsName}` };
  }
  return {
    ...base,
    backend: "running",
    node: { dnsName, hostName: hostname, tailnet: "example-net.ts.net", ips: ["100.64.0.7"] },
    owner: { id: "7", login: "maya@example.com", displayName: "Maya Reeves" },
    certificate,
    public: pub,
  };
}

const emit = () => process.stdout.write(`${JSON.stringify(status())}\n`);
emit();

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  if (command.type === "configure") wantPublic = command.public?.enabled === true;
  if (command.type === "login") {
    loginCount += 1;
    if (loginCount >= 2) signedIn = true;
  }
  if (command.type === "logout") {
    signedIn = false;
    loginCount = 0;
  }
  emit();
});
lines.on("close", () => process.exit(0));
