// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
