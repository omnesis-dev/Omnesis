// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const work = mkdtempSync(join(tmpdir(), "tailnet-sh-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// Source lib.sh and tailnet.sh and run one snippet under bash.
function sh(snippet) {
  return execFileSync(
    "bash",
    ["-c", `set -euo pipefail; . "$1/lib.sh"; . "$1/tailnet.sh"; ${snippet}`, "sh", here],
    { encoding: "utf8", env: { ...process.env, E2E_WORK: work } },
  );
}

describe("saved_dns_values", () => {
  it("keeps the addresses networksetup listed", () => {
    const file = join(work, "servers");
    writeFileSync(file, "192.0.2.53\n2001:db8::53\n");
    expect(sh(`saved_dns_values "${file}" '^[0-9A-Fa-f:.]+$'`)).toBe("192.0.2.53 2001:db8::53 ");
  });

  it("is empty when none were set, or nothing was saved", () => {
    const file = join(work, "none");
    writeFileSync(file, "There aren't any DNS Servers set on Ethernet.\n");
    expect(sh(`saved_dns_values "${file}" '^[0-9A-Fa-f:.]+$'`)).toBe("");
    expect(sh(`saved_dns_values "${file}" '^[A-Za-z0-9.-]+$'`)).toBe("");
    expect(sh(`saved_dns_values "${join(work, "missing")}" '^[A-Za-z0-9.-]+$'`)).toBe("");
  });
});

// On a Mac, the tailscale/github-action step points the system resolver at
// MagicDNS, which stops forwarding public names on the tailnet's next
// network-map change (see ts_restore_system_dns). These pin the collector
// job's defence.
describe("tailnet collector DNS", () => {
  const workflow = parse(readFileSync(join(root, ".github/workflows/install-e2e.yml"), "utf8"));
  const collector = workflow.jobs["tailnet-collector"];
  const steps = collector.steps;
  const tailscale = steps.findIndex((s) =>
    String(s.uses ?? "").startsWith("tailscale/github-action@"),
  );
  const index = (name) => steps.findIndex((s) => s.name === name);

  it("saves the Mac's DNS settings before the action repoints them", () => {
    const save = index("Remember the Mac's DNS settings");
    expect(save).toBeGreaterThanOrEqual(0);
    expect(save).toBeLessThan(tailscale);
    expect(steps[save].run).toContain('"$RUNNER_TEMP/install-e2e/dns-servers"');
  });

  it("joins without taking the tailnet's DNS, and bounds the lane step", () => {
    expect(steps[tailscale].with.args).toBe("--accept-dns=false");
    expect(steps[tailscale].with["log-mode"]).toBe("quiet");
    const lane = steps[index("Collector")];
    expect(lane["timeout-minutes"]).toBeLessThanOrEqual(60);
    expect(
      workflow.jobs["tailnet-gateway"].steps.find((s) => s.name === "Gateway")["timeout-minutes"],
    ).toBeLessThanOrEqual(60);
  });

  it("restores DNS, checks the way out and pins the gateway before using it", () => {
    const script = readFileSync(join(here, "tailnet-collector.sh"), "utf8");
    const at = (needle) => {
      const i = script.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at("\nts_restore_system_dns\n")).toBeLessThan(at("\nts_check_internet\n"));
    expect(at("\nts_check_internet\n")).toBeLessThan(at('ts_pin_host "$GATEWAY_HOST"'));
    expect(at('ts_pin_host "$GATEWAY_HOST"')).toBeLessThan(at('ts_wait_resolves "$GATEWAY_FQDN"'));
    // Checked again right before the install fetches from npm.
    expect(script.lastIndexOf("ts_check_internet")).toBeGreaterThan(
      at("Run the printed --collector line"),
    );
    expect(script.lastIndexOf("ts_check_internet")).toBeLessThan(at('sh "$INSTALL_SH"'));
  });
});

// A stand-in `tailscale` CLI for ts_wait_peer. The scenario names how the
// peer looks from this node, and `appearAfter` how many pings it takes for
// the peer to enter the network map. `ping` follows the real CLI: by default
// it stops on a direct path only, and fails with "direct connection not
// established" when its last pong came through a DERP relay.
const fakeBin = join(work, "bin");
mkdirSync(fakeBin);
writeFileSync(
  join(fakeBin, "tailscale"),
  `#!/usr/bin/env bash
set -u
pings="$(cat "$FAKE_TS/pings" 2>/dev/null || echo 0)"
present() { [ "$FAKE_TS_SCENARIO" != absent ] && [ "$pings" -ge "\${FAKE_TS_APPEAR_AFTER:-0}" ]; }
case "$1" in
  status)
    if present; then
      online=true; addr=""; relay=fra
      [ "$FAKE_TS_SCENARIO" = offline ] && online=false
      [ "$FAKE_TS_SCENARIO" = direct ] && addr="203.0.113.7:41641"
      printf '{"MagicDNSSuffix":"example-tailnet.ts.net","Peer":{"nodekey:1":{"HostName":"other","DNSName":"other.example-tailnet.ts.net.","Online":true,"CurAddr":"","Relay":"fra"},"nodekey:2":{"HostName":"gw","DNSName":"%s.example-tailnet.ts.net.","Online":%s,"CurAddr":"%s","Relay":"%s"}}}\\n' "$FAKE_TS_PEER" "$online" "$addr" "$relay"
    else
      printf '{"MagicDNSSuffix":"example-tailnet.ts.net","Peer":{"nodekey:1":{"HostName":"other","DNSName":"other.example-tailnet.ts.net.","Online":true}}}\\n'
    fi
    ;;
  ping)
    echo $((pings + 1)) >"$FAKE_TS/pings"
    until_direct=true
    for a in "$@"; do [ "$a" = --until-direct=false ] && until_direct=false; done
    host="\${!#}"
    if ! present; then
      echo "error looking up IP of \\"$host\\": lookup $host: no such host" >&2
      exit 1
    fi
    case "$FAKE_TS_SCENARIO" in
      offline)
        echo "ping \\"192.0.2.2\\" timed out"
        echo "no reply" >&2
        exit 1
        ;;
      direct)
        echo "pong from $host (192.0.2.2) via 203.0.113.7:41641 in 3ms"
        ;;
      *)
        echo "pong from $host (192.0.2.2) via DERP(fra) in 31ms"
        if [ "$until_direct" = true ]; then
          echo "direct connection not established" >&2
          exit 1
        fi
        ;;
    esac
    ;;
  *) exit 2 ;;
esac
`,
);
chmodSync(join(fakeBin, "tailscale"), 0o755);

const PEER = "omnesis-ci-gw-t1-1234-1";

function waitPeer(scenario, { seconds = 30, appearAfter = 0 } = {}) {
  const state = mkdtempSync(join(work, "ts-"));
  const r = spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail; . "$1/lib.sh"; . "$1/tailnet.sh"; ts_wait_peer "${PEER}" ${seconds}`,
      "sh",
      here,
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        E2E_WORK: work,
        E2E_TS_POLL_SECONDS: "0",
        FAKE_TS: state,
        FAKE_TS_SCENARIO: scenario,
        FAKE_TS_PEER: PEER,
        FAKE_TS_APPEAR_AFTER: String(appearAfter),
      },
    },
  );
  return { ...r, pings: Number(readFileSync(join(state, "pings"), "utf8")) };
}

describe("ts_wait_peer", () => {
  it("accepts a peer reachable only through a DERP relay", () => {
    const r = waitPeer("relayed");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`peer ${PEER} answers on the tailnet (relayed through DERP)`);
    expect(r.pings).toBe(1);
  });

  it("keeps pinging until a late peer enters the network map", () => {
    const r = waitPeer("relayed", { appearAfter: 3 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.pings).toBe(4);
  });

  it("names a direct path", () => {
    const r = waitPeer("direct");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`peer ${PEER} answers on the tailnet (direct)`);
  });

  it("says the peer never entered the network map, without addresses", () => {
    const r = waitPeer("absent", { seconds: 0 });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain(`peer ${PEER} is not in the local network map`);
    expect(r.stderr).toContain(`::error::peer ${PEER} never answered tailscale ping`);
    expect(r.stdout + r.stderr).toContain("no such host");
  });

  it("describes a peer in the network map that never answered, without addresses", () => {
    const r = waitPeer("offline", { seconds: 0 });
    expect(r.status).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toContain(
      `peer ${PEER} is in the local network map: offline, no direct path, DERP home fra`,
    );
    expect(out).toContain("last ping: no reply");
    expect(out).not.toMatch(/192\.0\.2|203\.0\.113|example-tailnet/);
  });
});
