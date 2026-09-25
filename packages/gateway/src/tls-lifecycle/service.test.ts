// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { TlsLifecycleService, type TlsMinter, type TlsPem } from "./service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const scratch = mkdtempSync(join(tmpdir(), "omnesis-tls-lifecycle-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let minted = 0;
/** A self-signed pair for the given names, valid for `days` from the real clock. */
function mint(days: number, sans: string[]): TlsPem {
  const name = `m${minted++}`;
  const cnf = join(scratch, `${name}.cnf`);
  writeFileSync(
    cnf,
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "x509_extensions = v3",
      "[dn]",
      `CN = ${name}`,
      "[v3]",
      "basicConstraints = CA:FALSE",
      `subjectAltName = ${sans.join(", ")}`,
    ].join("\n"),
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      String(days),
      "-keyout",
      join(scratch, `${name}.key`),
      "-out",
      join(scratch, `${name}.crt`),
      "-config",
      cnf,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return {
    cert: readFileSync(join(scratch, `${name}.crt`), "utf8"),
    key: readFileSync(join(scratch, `${name}.key`), "utf8"),
  };
}

/** A leaf for `sans` issued by a throwaway CA, standing in for a publicly chained certificate. */
function mintIssued(sans: string[]): TlsPem {
  const name = `i${minted++}`;
  const path = (ext: string) => join(scratch, `${name}.${ext}`);
  const run = (args: string[]) =>
    execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
  run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "30",
    "-subj",
    `/CN=${name}-ca`,
    "-keyout",
    path("ca.key"),
    "-out",
    path("ca.crt"),
  ]);
  run([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    `/CN=${name}`,
    "-keyout",
    path("key"),
    "-out",
    path("csr"),
  ]);
  writeFileSync(path("ext"), `subjectAltName = ${sans.join(", ")}\n`);
  run([
    "x509",
    "-req",
    "-in",
    path("csr"),
    "-CA",
    path("ca.crt"),
    "-CAkey",
    path("ca.key"),
    "-CAcreateserial",
    "-days",
    "30",
    "-extfile",
    path("ext"),
    "-out",
    path("crt"),
  ]);
  return { cert: readFileSync(path("crt"), "utf8"), key: readFileSync(path("key"), "utf8") };
}

const fingerprintOf = (pem: string): string =>
  new X509Certificate(pem).fingerprint256.replace(/:/gu, "").toLowerCase();
const notAfterOf = (pem: string): number => Date.parse(new X509Certificate(pem).validTo);

const NAMES = ["DNS:localhost", "DNS:gateway", "DNS:omnesis.local"];
const outgoing = mint(90, NAMES);
const fresh = mint(3650, NAMES);
const foreignKey = mint(90, NAMES).key;
const narrower = mint(3650, ["DNS:localhost"]);

interface Rig {
  configDir: string;
  service: TlsLifecycleService;
  activations: TlsPem[];
  rotations: string[];
  minter: { calls: number; next: () => Promise<TlsPem> | TlsPem };
  clock: { now: number };
  settings: { autoRenew: boolean; renewBeforeDays: number };
}

let rig: Rig;
let configDir: string;

function writePair(dir: string, pair: TlsPem, cert = "cert.pem", key = "key.pem"): void {
  mkdirSync(join(dir, "tls"), { recursive: true });
  writeFileSync(join(dir, "tls", cert), pair.cert);
  writeFileSync(join(dir, "tls", key), pair.key);
}

function build(
  overrides: {
    initial?: TlsPem;
    now?: number;
    env?: { certPath?: string; keyPath?: string };
    requiredHosts?: string[];
    inContainer?: boolean;
    settings?: Partial<Rig["settings"]>;
    activate?: (material: TlsPem) => void;
  } = {},
): Rig {
  const initial = overrides.initial ?? outgoing;
  const clock = { now: overrides.now ?? Date.now() };
  const settings = { autoRenew: true, renewBeforeDays: 30, ...overrides.settings };
  const activations: TlsPem[] = [];
  const rotations: string[] = [];
  const minter = { calls: 0, next: (): Promise<TlsPem> | TlsPem => fresh };
  const tlsMinter: TlsMinter = {
    async mint() {
      minter.calls += 1;
      return minter.next();
    },
  };
  const service = new TlsLifecycleService({
    configDir,
    initial,
    activate: (material) => {
      overrides.activate?.(material);
      activations.push(material);
    },
    materialPaths: () => overrides.env ?? {},
    requiredHosts: () => overrides.requiredHosts ?? ["localhost", "gateway"],
    minter: tlsMinter,
    settings: () => settings,
    inContainer: overrides.inContainer ?? false,
    now: () => clock.now,
    onRotation: (fp) => rotations.push(fp),
  });
  return { configDir, service, activations, rotations, minter, clock, settings };
}

beforeEach(() => {
  configDir = mkdtempSync(join(scratch, "config-"));
  writePair(configDir, outgoing);
});
afterEach(() => rmSync(configDir, { recursive: true, force: true }));

const signal = () => new AbortController().signal;

describe("snapshot", () => {
  test("describes the served self-signed material, its renewal mode and the names it misses", () => {
    rig = build({ requiredHosts: ["localhost", "gw.tail.example"] });
    const snapshot = rig.service.snapshot();
    expect(snapshot.ownership).toBe("self-signed");
    expect(snapshot.certPath).toBe(join(configDir, "tls", "cert.pem"));
    expect(snapshot.served.state).toBe("valid");
    expect(snapshot.served.fingerprintSha256).toBe(fingerprintOf(outgoing.cert));
    expect(snapshot.served.uncoveredHosts).toEqual(["gw.tail.example"]);
    expect(snapshot.renewal).toEqual({
      mode: "automatic",
      renewBeforeDays: 30,
      lastAttemptAt: null,
      lastError: null,
      lastRenewedAt: null,
    });
    expect(snapshot.pendingReplacement).toBeNull();
    expect(snapshot.rotation).toBeNull();
  });

  test("an operator's own material is external; installer tiers in a container renew on the host", () => {
    writePair(configDir, outgoing, "tailscale.crt", "tailscale.key");
    const external = build({
      env: { certPath: "/etc/ssl/gw.crt", keyPath: "/etc/ssl/gw.key" },
    }).service.snapshot();
    expect(external.ownership).toBe("external");
    expect(external.renewal.mode).toBe("external");

    const tier = {
      certPath: join(configDir, "tls", "tailscale.crt"),
      keyPath: join(configDir, "tls", "tailscale.key"),
    };
    expect(build({ env: tier, inContainer: true }).service.snapshot().renewal.mode).toBe("host");
    expect(build({ env: tier }).service.snapshot().renewal.mode).toBe("automatic");
    expect(
      build({ env: tier, settings: { autoRenew: false } }).service.snapshot().renewal.mode,
    ).toBe("disabled");
  });
});

describe("refresh", () => {
  test("leaves a valid certificate alone and asks the minter nothing", async () => {
    rig = build();
    const snapshot = await rig.service.refresh(signal());
    expect(snapshot.served.state).toBe("valid");
    expect(rig.minter.calls).toBe(0);
    expect(rig.activations).toEqual([]);
  });

  test("renews an expiring certificate: verified, written into place, activated, recorded", async () => {
    rig = build({ now: notAfterOf(outgoing.cert) - 10 * DAY_MS });
    const snapshot = await rig.service.refresh(signal());

    expect(rig.minter.calls).toBe(1);
    expect(snapshot.served.fingerprintSha256).toBe(fingerprintOf(fresh.cert));
    expect(snapshot.served.state).toBe("valid");
    expect(rig.activations).toEqual([fresh]);
    expect(rig.rotations).toEqual([fingerprintOf(fresh.cert)]);
    expect(readFileSync(join(configDir, "tls", "cert.pem"), "utf8")).toBe(fresh.cert);
    expect(readFileSync(join(configDir, "tls", "key.pem"), "utf8")).toBe(fresh.key);
    expect(snapshot.renewal.lastRenewedAt).toBe(new Date(rig.clock.now).toISOString());
    expect(snapshot.renewal.lastError).toBeNull();
    expect(snapshot.rotation).toEqual({
      previousFingerprintSha256: fingerprintOf(outgoing.cert),
      rotatedAt: new Date(rig.clock.now).toISOString(),
    });
    expect(rig.service.fingerprintSha256()).toBe(fingerprintOf(fresh.cert));
    expect(existsSync(join(configDir, "tls", ".renew.lock"))).toBe(false);
  });

  test("an expired certificate is renewed too, and stays reported as expired when renewal fails", async () => {
    rig = build({ now: notAfterOf(outgoing.cert) + DAY_MS });
    rig.minter.next = () => {
      throw new Error("`tailscale cert` failed: HTTPS is not enabled for this tailnet");
    };
    const snapshot = await rig.service.refresh(signal());

    expect(snapshot.served.state).toBe("expired");
    expect(snapshot.served.fingerprintSha256).toBe(fingerprintOf(outgoing.cert));
    expect(snapshot.renewal.lastError).toMatch(/HTTPS is not enabled/u);
    expect(snapshot.renewal.lastAttemptAt).toBe(new Date(rig.clock.now).toISOString());
    expect(snapshot.renewal.lastRenewedAt).toBeNull();
    expect(rig.activations).toEqual([]);
    expect(readFileSync(join(configDir, "tls", "cert.pem"), "utf8")).toBe(outgoing.cert);
  });

  test("a minted replacement that fails verification never reaches disk or the server", async () => {
    rig = build({ now: notAfterOf(outgoing.cert) - 10 * DAY_MS });
    const cases: Array<[string, TlsPem, RegExp]> = [
      ["a key from another certificate", { cert: fresh.cert, key: foreignKey }, /does not belong/u],
      ["a certificate that dropped a served name", narrower, /does not cover gateway/u],
      ["text that is not a certificate", { cert: "nope", key: fresh.key }, /did not parse/u],
    ];
    for (const [, candidate, reason] of cases) {
      rig.minter.next = () => candidate;
      const outcome = await rig.service.renew(signal());
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(reason);
      expect(outcome.snapshot.renewal.lastError).toMatch(reason);
    }
    expect(rig.activations).toEqual([]);
    expect(readFileSync(join(configDir, "tls", "cert.pem"), "utf8")).toBe(outgoing.cert);
    expect(readFileSync(join(configDir, "tls", "key.pem"), "utf8")).toBe(outgoing.key);
    expect(existsSync(join(configDir, "tls", ".renew.lock"))).toBe(false);
  });

  test("a self-signed renewal keeps the addressed names the outgoing certificate covered, and may add none", async () => {
    // A new address in OMNESIS_GATEWAY_URL is not a reason to refuse the
    // renewal: what the outgoing certificate never covered is reported, not
    // demanded of the replacement.
    rig = build({
      now: notAfterOf(outgoing.cert) - 10 * DAY_MS,
      requiredHosts: ["localhost", "gateway", "new-host.example"],
    });
    const outcome = await rig.service.renew(signal());
    expect(outcome.ok).toBe(true);
    expect(outcome.snapshot.served.uncoveredHosts).toEqual(["new-host.example"]);

    // What it did cover must stay covered.
    rig = build({ now: notAfterOf(outgoing.cert) - 10 * DAY_MS, requiredHosts: ["gateway"] });
    rig.minter.next = () => narrower;
    const refused = await rig.service.renew(signal());
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/does not cover gateway.*OMNESIS_GATEWAY_URL/u);
  });

  test("a write or activation that fails leaves the served pair on disk as well as in memory", async () => {
    rig = build({
      now: notAfterOf(outgoing.cert) - 10 * DAY_MS,
      activate: () => {
        throw new Error("the HTTPS server is not listening yet");
      },
    });
    const outcome = await rig.service.renew(signal());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok)
      expect(outcome.reason).toMatch(/could not be put into service.*not listening/u);
    expect(readFileSync(join(configDir, "tls", "cert.pem"), "utf8")).toBe(outgoing.cert);
    expect(readFileSync(join(configDir, "tls", "key.pem"), "utf8")).toBe(outgoing.key);
    expect(outcome.snapshot.served.fingerprintSha256).toBe(fingerprintOf(outgoing.cert));
    expect(outcome.snapshot.rotation).toBeNull();
  });

  test("an operator's own pair is left byte for byte, however expired", async () => {
    writeFileSync(join(configDir, "own.crt"), outgoing.cert);
    writeFileSync(join(configDir, "own.key"), outgoing.key);
    rig = build({
      now: notAfterOf(outgoing.cert) + DAY_MS,
      env: { certPath: join(configDir, "own.crt"), keyPath: join(configDir, "own.key") },
    });
    const ticked = await rig.service.refresh(signal());
    expect(ticked.served.state).toBe("expired");
    const forced = await rig.service.renew(signal(), { force: true });
    expect(forced.ok).toBe(false);
    expect(rig.minter.calls).toBe(0);
    expect(rig.activations).toEqual([]);
    expect(readFileSync(join(configDir, "own.crt"), "utf8")).toBe(outgoing.cert);
    expect(readFileSync(join(configDir, "own.key"), "utf8")).toBe(outgoing.key);
  });

  test("automatic renewal is skipped for external material, in a container, and when switched off", async () => {
    const dueAt = notAfterOf(outgoing.cert) - 10 * DAY_MS;
    writePair(configDir, outgoing, "mkcert.crt", "mkcert.key");
    const tier = {
      certPath: join(configDir, "tls", "mkcert.crt"),
      keyPath: join(configDir, "tls", "mkcert.key"),
    };
    for (const rigUnderTest of [
      build({ now: dueAt, env: { certPath: "/etc/ssl/gw.crt", keyPath: "/etc/ssl/gw.key" } }),
      build({ now: dueAt, env: tier, inContainer: true }),
      build({ now: dueAt, env: tier, settings: { autoRenew: false } }),
    ]) {
      const snapshot = await rigUnderTest.service.refresh(signal());
      expect(rigUnderTest.minter.calls).toBe(0);
      expect(snapshot.served.state).toBe("expiring");
    }
  });
});

describe("renew on request", () => {
  test("force renews material that is not due, and disabled material, but never an operator's", async () => {
    rig = build();
    const notDue = await rig.service.renew(signal());
    expect(notDue.ok).toBe(false);
    if (!notDue.ok) expect(notDue.reason).toMatch(/not due for renewal \(89 days remain/u);
    expect(rig.minter.calls).toBe(0);

    const forced = await rig.service.renew(signal(), { force: true });
    expect(forced.ok).toBe(true);
    expect(rig.activations).toEqual([fresh]);

    rig = build({ settings: { autoRenew: false } });
    expect((await rig.service.renew(signal(), { force: true })).ok).toBe(true);

    rig = build({ env: { certPath: "/etc/ssl/gw.crt", keyPath: "/etc/ssl/gw.key" } });
    const external = await rig.service.renew(signal(), { force: true });
    expect(external.ok).toBe(false);
    if (!external.ok) expect(external.reason).toMatch(/operator-managed/u);
    expect(rig.minter.calls).toBe(0);
  });

  test("concurrent requests share one attempt", async () => {
    rig = build();
    let release!: (pem: TlsPem) => void;
    rig.minter.next = () => new Promise<TlsPem>((resolve) => (release = resolve));
    const first = rig.service.renew(signal(), { force: true });
    const second = rig.service.renew(signal(), { force: true });
    release(fresh);
    const [a, b] = await Promise.all([first, second]);
    expect(a.ok && b.ok).toBe(true);
    expect(rig.minter.calls).toBe(1);
    expect(rig.activations).toHaveLength(1);
  });

  test("another process's live lock is respected; a stale one is taken over", async () => {
    rig = build();
    const lock = join(configDir, "tls", ".renew.lock");
    writeFileSync(lock, JSON.stringify({ pid: 424242 }));
    const held = await rig.service.renew(signal(), { force: true });
    expect(held.ok).toBe(false);
    if (!held.ok) expect(held.reason).toMatch(/Another renewal is in progress/u);
    expect(rig.minter.calls).toBe(0);
    expect(held.snapshot.renewal.lastAttemptAt).toBeNull();

    const stale = new Date(rig.clock.now - 11 * 60 * 1000);
    utimesSync(lock, stale, stale);
    const taken = await rig.service.renew(signal(), { force: true });
    expect(taken.ok).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("activation from disk", () => {
  test("a valid pair written by another tool is activated on the next tick, with the rotation recorded", async () => {
    rig = build();
    writePair(configDir, fresh);
    const snapshot = await rig.service.refresh(signal());
    expect(rig.activations).toEqual([fresh]);
    expect(snapshot.served.fingerprintSha256).toBe(fingerprintOf(fresh.cert));
    expect(snapshot.pendingReplacement).toBeNull();
    expect(snapshot.rotation?.previousFingerprintSha256).toBe(fingerprintOf(outgoing.cert));
    expect(rig.rotations).toEqual([fingerprintOf(fresh.cert)]);
    expect(rig.minter.calls).toBe(0);
  });

  test("a replacement that does not pass is reported and the served material stays", async () => {
    rig = build();
    writePair(configDir, { cert: fresh.cert, key: foreignKey });
    let snapshot = await rig.service.refresh(signal());
    expect(rig.activations).toEqual([]);
    expect(snapshot.served.fingerprintSha256).toBe(fingerprintOf(outgoing.cert));
    expect(snapshot.pendingReplacement).toEqual({
      fingerprintSha256: fingerprintOf(fresh.cert),
      error: expect.stringMatching(/does not belong/u),
    });

    rmSync(join(configDir, "tls", "cert.pem"));
    snapshot = await rig.service.refresh(signal());
    expect(snapshot.pendingReplacement?.error).toMatch(/could not be read/u);
    expect(rig.activations).toEqual([]);
  });

  test("a replacement ahead of the clock is not activated", async () => {
    rig = build({ now: Date.now() - 2 * DAY_MS, settings: { autoRenew: false } });
    writePair(configDir, fresh);
    const snapshot = await rig.service.refresh(signal());
    expect(rig.activations).toEqual([]);
    expect(snapshot.pendingReplacement?.error).toMatch(/not valid before/u);
  });

  test("a replacement the server cannot take yet stays pending, with the reason", async () => {
    rig = build({
      activate: () => {
        throw new Error("the HTTPS server is not listening yet");
      },
    });
    writePair(configDir, fresh);
    const snapshot = await rig.service.refresh(signal());
    expect(snapshot.pendingReplacement?.error).toMatch(/could not be activated.*not listening/u);
    expect(snapshot.served.fingerprintSha256).toBe(fingerprintOf(outgoing.cert));
    expect(snapshot.rotation).toBeNull();
    expect(rig.rotations).toEqual([]);
  });

  test("a replacement that already expired is not activated, whatever the served one's state", async () => {
    rig = build({ now: notAfterOf(fresh.cert) + DAY_MS, settings: { autoRenew: false } });
    writePair(configDir, fresh);
    const snapshot = await rig.service.refresh(signal());
    expect(rig.activations).toEqual([]);
    expect(snapshot.pendingReplacement?.error).toMatch(/expired on/u);
    expect(snapshot.served.state).toBe("expired");
  });

  test("a provisioning run that moved the paths in .env is followed without a restart", async () => {
    const paths = { certPath: "", keyPath: "" };
    rig = build({ env: paths });
    writePair(configDir, fresh, "tailscale.crt", "tailscale.key");
    paths.certPath = join(configDir, "tls", "tailscale.crt");
    paths.keyPath = join(configDir, "tls", "tailscale.key");
    const snapshot = await rig.service.refresh(signal());
    expect(snapshot.ownership).toBe("tailscale");
    expect(rig.activations).toEqual([fresh]);
  });
});

describe("restart", () => {
  test("a gateway restarted after a renewal serves the renewed pair and remembers the rotation", async () => {
    rig = build({ now: notAfterOf(outgoing.cert) - 10 * DAY_MS });
    await rig.service.refresh(signal());

    const onDisk = {
      cert: readFileSync(join(configDir, "tls", "cert.pem"), "utf8"),
      key: readFileSync(join(configDir, "tls", "key.pem"), "utf8"),
    };
    const restarted = build({ initial: onDisk, now: rig.clock.now + DAY_MS });
    const snapshot = restarted.service.snapshot();
    expect(snapshot.served.fingerprintSha256).toBe(fingerprintOf(fresh.cert));
    expect(snapshot.renewal.lastRenewedAt).toBe(new Date(rig.clock.now).toISOString());
    expect(snapshot.rotation?.previousFingerprintSha256).toBe(fingerprintOf(outgoing.cert));
    expect(await restarted.service.refresh(signal())).toMatchObject({ pendingReplacement: null });
    expect(restarted.activations).toEqual([]);
  });

  test("a record that does not parse is ignored rather than trusted", () => {
    writeFileSync(join(configDir, "tls", "lifecycle.json"), "{not json");
    expect(build().service.snapshot().renewal.lastAttemptAt).toBeNull();
  });
});

describe("publiclyTrustedNames", () => {
  const tier = () => ({
    certPath: join(configDir, "tls", "tailscale.crt"),
    keyPath: join(configDir, "tls", "tailscale.key"),
  });

  test("names the DNS names of a served Tailscale certificate", () => {
    const tailscale = mintIssued(["DNS:studio.tail-example.ts.net"]);
    writePair(configDir, tailscale, "tailscale.crt", "tailscale.key");
    const { service } = build({ initial: tailscale, env: tier() });
    expect(service.publiclyTrustedNames()).toEqual(["studio.tail-example.ts.net"]);
  });

  test("names nothing for the self-signed, mkcert or external tiers", () => {
    expect(build().service.publiclyTrustedNames()).toEqual([]);
    const issued = mintIssued(["DNS:gateway.example.com"]);
    writePair(configDir, issued, "mkcert.crt", "mkcert.key");
    const mkcert = build({
      initial: issued,
      env: {
        certPath: join(configDir, "tls", "mkcert.crt"),
        keyPath: join(configDir, "tls", "mkcert.key"),
      },
    });
    expect(mkcert.service.publiclyTrustedNames()).toEqual([]);
    const external = build({
      initial: issued,
      env: { certPath: "/etc/ssl/gw.crt", keyPath: "/etc/ssl/gw.key" },
    });
    expect(external.service.publiclyTrustedNames()).toEqual([]);
  });

  test("names nothing once the Tailscale certificate has expired", () => {
    const tailscale = mintIssued(["DNS:studio.tail-example.ts.net"]);
    writePair(configDir, tailscale, "tailscale.crt", "tailscale.key");
    const { service } = build({
      initial: tailscale,
      env: tier(),
      now: notAfterOf(tailscale.cert) + DAY_MS,
    });
    expect(service.publiclyTrustedNames()).toEqual([]);
  });

  test("names nothing while a self-signed certificate is still what is served", () => {
    writePair(configDir, outgoing, "tailscale.crt", "tailscale.key");
    expect(build({ env: tier() }).service.publiclyTrustedNames()).toEqual([]);
  });
});

describe("nextRenewalAt", () => {
  const tier = () => ({
    certPath: join(configDir, "tls", "tailscale.crt"),
    keyPath: join(configDir, "tls", "tailscale.key"),
  });

  test("is the start of the renewal band for a certificate the gateway renews itself", () => {
    const tailscale = mintIssued(["DNS:studio.tail-example.ts.net"]);
    writePair(configDir, tailscale, "tailscale.crt", "tailscale.key");
    const { service } = build({
      initial: tailscale,
      env: tier(),
      settings: { renewBeforeDays: 10 },
    });
    expect(service.nextRenewalAt()?.getTime()).toBe(notAfterOf(tailscale.cert) - 10 * DAY_MS);
  });

  test("is null while a self-signed certificate is still served under Tailscale paths", () => {
    writePair(configDir, outgoing, "tailscale.crt", "tailscale.key");
    expect(build({ env: tier() }).service.nextRenewalAt()).toBeNull();
  });

  test("is null for the self-signed certificate and when renewal is off", () => {
    expect(build().service.nextRenewalAt()).toBeNull();
    const tailscale = mintIssued(["DNS:studio.tail-example.ts.net"]);
    writePair(configDir, tailscale, "tailscale.crt", "tailscale.key");
    const off = build({ initial: tailscale, env: tier(), settings: { autoRenew: false } });
    expect(off.service.nextRenewalAt()).toBeNull();
  });
});
