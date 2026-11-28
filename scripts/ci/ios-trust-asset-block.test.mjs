// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..", "..");
const SCRIPT = join(root, "scripts", "ci", "ios-trust-asset-block.sh");
const UDID = "00000000-0000-4000-8000-000000000001";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// trustd's own messages from a hosted run (#1253), the paths left out: two
// catalog checks and a pinning database update that stopped every TLS
// connection in the simulator for two minutes, and a run with the block.
const UPDATED = [
  "13:47:59.984 Df trustd[39181:17f7b] [com.apple.securityd:OTATrust] Using system trust store 2026040100 instead of asset trust store 0",
  "13:49:25.138 Df trustd[39181:17f85] [com.apple.securityd:OTATrust] begin download of OTATrust asset",
  "13:50:45.525 Df trustd[39181:17f8d] [com.apple.securityd:validupdate] download started at (date)",
  "13:51:10.588 Df trustd[39181:17f88] [com.apple.securityd:pinningDb] Pinning database should update from version 121 to version 131",
  "13:54:03.650 Df trustd[39181:17f88] [com.apple.securityd:OTATrust] updating asset version from 1013 to 1014",
];
const BLOCKED = [
  "13:29:11.827 Df trustd[7605:5858] [com.apple.securityd:OTATrust] Using system trust store 2026040100 instead of asset trust store 0",
  "13:29:33.387 Df trustd[7605:58b2] [com.apple.securityd:OTATrust] begin MobileAsset query for catalog com.apple.MobileAsset.PKITrustSupplementals",
  "13:29:33.401 E  trustd[7605:58b2] [com.apple.securityd:OTATrust] failed to download catalog for asset com.apple.MobileAsset.PKITrustSupplementals: 9",
];

/** Runs `report` with a stand-in `xcrun` whose simulator log holds `lines`. */
function report({ lines, record, baseline, exit = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-trust-assets-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const state = join(dir, "ios-trust-assets");
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(join(dir, "log"), lines.map((line) => `2026-11-23 ${line}\n`).join(""));
  writeFileSync(join(dir, "args"), "");
  writeFileSync(
    join(bin, "xcrun"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, "args")}"\ncat "${join(dir, "log")}"\nexit ${exit}\n`,
  );
  chmodSync(join(bin, "xcrun"), 0o755);
  if (record) writeFileSync(join(state, "dns-sink.log"), record.join("\n") + "\n");
  if (baseline !== undefined) writeFileSync(join(state, "baseline"), `${baseline}\n`);
  const result = spawnSync("bash", [SCRIPT, "report"], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: dir,
      OMNESIS_JOURNEY_IOS_UDID: UDID,
    },
    encoding: "utf8",
  });
  return { ...result, args: readFileSync(join(dir, "args"), "utf8").trim().split("\n") };
}

describe("the iOS trust asset report", () => {
  test("warns with trustd's own messages when it updated its trust data", () => {
    const result = report({ lines: UPDATED });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "::warning::the simulator's trust service still updated its trust data",
    );
    // The update messages only, not trustd's ordinary ones.
    expect(result.stdout).not.toContain("Using system trust store");
    for (const message of [
      "begin download of OTATrust asset",
      "download started at",
      "Pinning database should update from version 121 to version 131",
      "updating asset version from 1013 to 1014",
    ])
      expect(result.stdout).toContain(message);
    // It reads the named simulator's trustd, from before the journeys began.
    expect(result.args).toEqual(expect.arrayContaining(["spawn", UDID, "--last", "3h"]));
    expect(result.args.join(" ")).toContain('process == "trustd"');
  });

  test("says trustd updated nothing when its catalog checks were refused", () => {
    const result = report({
      lines: BLOCKED,
      record: [
        "13:20:00 DNS query for mesu.apple.com",
        "13:29:33 DNS query for mesu.apple.com",
        "13:29:34 DNS query for GDMF.apple.com",
        "13:41:05 DNS query for mesu.apple.com",
      ],
      baseline: 1,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("::warning::");
    expect(result.stdout).toContain(
      "The simulator's trust service updated none of its trust data.",
    );
    // The block's own probe (before the baseline) is not counted.
    expect(result.stdout).toMatch(/^\s+2 {2}13:29:33 {2}13:41:05 {2}mesu\.apple\.com$/m);
    expect(result.stdout).toMatch(/^\s+1 {2}13:29:34 {2}13:29:34 {2}gdmf\.apple\.com$/m);
  });
});

describe("the iOS trust asset report never claims a quiet trust service it did not read", () => {
  test("when the simulator's log cannot be read", () => {
    const result = report({ lines: ["Invalid device: simulator not booted"], exit: 1 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "::warning::could not read the simulator's trust service log: 2026-11-23 Invalid device: simulator not booted",
    );
    expect(result.stdout).not.toContain("updated none");
  });

  test("when trustd logged nothing at all", () => {
    const result = report({ lines: [] });
    expect(result.stdout).toContain(
      "::warning::the simulator's trust service logged nothing about its trust data",
    );
    expect(result.stdout).not.toContain("updated none");
  });
});

describe("the iOS trust asset block", () => {
  test("refuses to run anywhere but macOS", () => {
    if (process.platform === "darwin") return;
    const dir = mkdtempSync(join(tmpdir(), "omnesis-trust-assets-"));
    dirs.push(dir);
    const result = spawnSync("bash", [SCRIPT, "block"], {
      env: { ...process.env, RUNNER_TEMP: dir },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("macOS runners only");
  });

  test("is in place before the journeys' simulator boots, and reported after the lane", () => {
    const workflow = parse(
      readFileSync(join(root, ".github", "workflows", "mobile-journeys.yml"), "utf8"),
    );
    const names = workflow.jobs.ios.steps.map((step) => step.name);
    const block = names.indexOf(
      "Keep the simulator's trust service off Apple's trust asset servers",
    );
    const boot = names.indexOf("Prepare iPhone simulator");
    const lane = names.indexOf("lane [ios-journeys]");
    const reported = names.indexOf("Report the simulator's trust asset activity");
    expect(block).toBeGreaterThan(-1);
    expect(block).toBeLessThan(boot);
    expect(reported).toBeGreaterThan(lane);
    expect(workflow.jobs.ios.steps[block]).toMatchObject({
      id: "trust-assets",
      run: "$GITHUB_WORKSPACE/scripts/ci/ios-trust-asset-block.sh block",
    });
    expect(workflow.jobs.ios.steps[reported]).toMatchObject({
      if: "${{ always() && steps.trust-assets.outcome == 'success' }}",
      run: "$GITHUB_WORKSPACE/scripts/ci/ios-trust-asset-block.sh report",
    });
  });
});

const trustDomains = [
  "mesu.apple.com",
  "gdmf.apple.com",
  "updates.cdn-apple.com",
  "updates-http.cdn-apple.com",
  "appldnld.apple.com",
  "lcdn-locator.apple.com",
  "valid.apple.com",
];

/** Actual block shell; every OS/DNS command is an owned deterministic stand-in. */
function blockFixture(scenario) {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-trust-domain-evidence-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const shim = `#!${process.execPath}
const fs = require('node:fs');
const {join,basename} = require('node:path');
const root = process.env.OWNED_TRUST_FIXTURE;
const scenario = process.env.OWNED_TRUST_SCENARIO;
const domains = ${JSON.stringify(trustDomains)};
const record = join(root,'ios-trust-assets/dns-sink.log');
const args = process.argv.slice(2), role = basename(process.argv[1]);
const audit = value => fs.appendFileSync(join(root,'audit'),JSON.stringify(value)+'\\n');
const refusal = domain => fs.appendFileSync(record,'00:00:00 DNS query for '+domain+'\\n');
const refused = () => { process.stderr.write('Unexpected owned command\\n');process.exit(91); };
if (role === 'uname') {
 if (args.length !== 1 || args[0] !== '-s') refused();
 fs.writeFileSync(1,'Darwin\\n');
} else if (role === 'nohup') {
 if (JSON.stringify(args) !== JSON.stringify(['python3',${JSON.stringify(join(root, "scripts/ci/dns-sink.py"))},'5534',record])) refused();
 if (scenario === 'stale') refusal('gdmf.apple.com');
 audit({kind:'sink-ready'});fs.writeFileSync(1,'ready\\n');
} else if (role === 'sudo') {
 if (JSON.stringify(args) === JSON.stringify(['mkdir','-p','/etc/resolver'])) {
  fs.mkdirSync(join(root,'resolver'));audit({kind:'resolver-directory'});
 } else if (args.length === 2 && args[0] === 'tee' && args[1].startsWith('/etc/resolver/')) {
  const domain = args[1].slice('/etc/resolver/'.length);
  if (!domains.includes(domain)) refused();
  const rule = fs.readFileSync(0,'utf8');
  if (rule !== 'nameserver 127.0.0.1\\nport 5534\\ntimeout 2\\n') refused();
  fs.writeFileSync(join(root,'resolver',domain),rule);audit({kind:'install',domain});
 } else if (JSON.stringify(args) === JSON.stringify(['dscacheutil','-flushcache'])) {
  if (!domains.every(domain => fs.existsSync(join(root,'resolver',domain)))) refused();
  audit({kind:'cache-flush'});
  if (scenario === 'early') refusal('GDMF.APPLE.COM');
 } else if (JSON.stringify(args) === JSON.stringify(['killall','-HUP','mDNSResponder'])) {
  audit({kind:'resolver-refresh'});
 } else refused();
} else if (role === 'node') {
 const domain = args[2];
 if (args.length !== 3 || args[0] !== '-e' || process.env.NODE_OPTIONS !== '' || ![...domains,'github.com'].includes(domain)) refused();
 audit({kind:'probe',domain});
 let resolves = domain === 'github.com' ? scenario !== 'general-fails' : scenario === 'target-resolves' && domain === 'gdmf.apple.com';
 if (domains.includes(domain)) {
  if (domain !== 'gdmf.apple.com' || !['early','stale','unrelated','malformed','suffix'].includes(scenario)) refusal(domain);
  else if (scenario === 'unrelated') refusal('mesu.apple.com');
  else if (scenario === 'malformed') fs.appendFileSync(record,'malformed journal entry for gdmf.apple.com\\n');
  else if (scenario === 'suffix') refusal('gdmf.apple.com.example.test');
 }
 fs.writeFileSync(2,domain+': '+(resolves?'resolved':'ENOTFOUND')+'\\n');
 process.exitCode = resolves ? 0 : 1;
} else refused();
`;
  for (const name of ["uname", "nohup", "sudo", "node"])
    writeFileSync(join(bin, name), shim, { mode: 0o700 });
  // The actual script's fake sink is a direct owned background job. Even a
  // failing block returns only after this isolated shell has joined that job.
  const result = spawnSync(
    "/bin/bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      "trap 'wait' EXIT; source \"$1\" block",
      "owned-trust-fixture",
      SCRIPT,
    ],
    {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        LANG: "C",
        RUNNER_TEMP: dir,
        OWNED_TRUST_FIXTURE: dir,
        OWNED_TRUST_SCENARIO: scenario,
      },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  expect(result.error).toBeUndefined();
  const audit = readFileSync(join(dir, "audit"), "utf8").trim().split("\n").map(JSON.parse);
  expect(audit.filter(({ kind }) => kind === "install").map(({ domain }) => domain)).toEqual(
    trustDomains,
  );
  for (const domain of trustDomains)
    expect(readFileSync(join(dir, "resolver", domain), "utf8")).toBe(
      "nameserver 127.0.0.1\nport 5534\ntimeout 2\n",
    );
  expect(audit.filter(({ kind }) => kind === "cache-flush")).toHaveLength(1);
  expect(audit.filter(({ kind }) => kind === "resolver-refresh")).toHaveLength(1);
  return { ...result, audit };
}

describe("the actual trust guard requires per-domain evidence from the installed configuration", () => {
  test("a matching post-configuration refusal before its own probe qualifies a later negative lookup", () => {
    const result = blockFixture("early");
    expect(result.status).toBe(0);
    expect(result.audit.filter(({ kind }) => kind === "probe").map(({ domain }) => domain)).toEqual(
      [...trustDomains, "github.com"],
    );
  });

  test("an unrelated domain's new refusal cannot qualify the target's failed lookup", () => {
    const result = blockFixture("unrelated");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gdmf.apple.com");
  });

  test("a matching refusal only before configuration cannot qualify a later failed lookup", () => {
    expect(blockFixture("stale").status).toBe(1);
  });

  test.each(["malformed", "suffix"])(
    "%s journal evidence cannot qualify the target",
    (scenario) => {
      expect(blockFixture(scenario).status).toBe(1);
    },
  );

  test("fresh exact domain refusals and a positive general lookup qualify the block", () => {
    const result = blockFixture("fresh");
    expect(result.status).toBe(0);
    expect(result.audit.at(-1)).toEqual({ kind: "probe", domain: "github.com" });
  });

  test("recorded refusals do not qualify a target that still resolves", () => {
    expect(blockFixture("target-resolves").status).toBe(1);
  });

  test("a positive general DNS lookup remains required", () => {
    const result = blockFixture("general-fails");
    expect(result.status).toBe(1);
    expect(result.audit.at(-1)).toEqual({ kind: "probe", domain: "github.com" });
    expect(result.stderr).toContain("broke name resolution for everything else");
  });
});
