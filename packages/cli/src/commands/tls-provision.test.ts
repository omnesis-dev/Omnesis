// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  defaultTlsProvisionEnv,
  mkcertGatewayUrl,
  mkcertNetworkAddresses,
  phoneRepairLines,
  provisionTls,
  type TlsProvisionEnv,
} from "./tls-provision.js";

describe("defaultTlsProvisionEnv", () => {
  it("uses the connected macOS app for status, DNS, and certificate issuance", () => {
    const home = mkdtempSync(join(tmpdir(), "omnesis-tailscale-cli-"));
    try {
      const cli = join(home, "Applications/Tailscale.app/Contents/MacOS/Tailscale");
      const disconnected = join(home, "bin/tailscale");
      mkdirSync(dirname(cli), { recursive: true });
      mkdirSync(dirname(disconnected), { recursive: true });
      writeFileSync(disconnected, '#!/bin/sh\nprintf \'{"BackendState":"NeedsLogin"}\\n\'\n');
      writeFileSync(
        cli,
        '#!/bin/sh\n[ "$TAILSCALE_BE_CLI" = 1 ] || exit 1\ncase "$1" in\n  status) if [ "$2" = --json ]; then printf \'{"BackendState":"Running","Self":{"DNSName":"gw.example.ts.net."}}\\n\'; fi ;;\n  cert) printf "CERT" > "$3"; printf "KEY" > "$5" ;;\n  *) exit 1 ;;\nesac\n',
      );
      chmodSync(cli, 0o755);
      chmodSync(disconnected, 0o755);
      const env = defaultTlsProvisionEnv(
        [
          { file: disconnected, bundledApp: false },
          { file: cli, bundledApp: true },
        ],
        home,
      );
      expect(env.hasTailscale()).toBe(true);
      expect(env.tailscaleDnsName()).toBe("gw.example.ts.net");
      const cert = join(home, "cert.pem");
      const key = join(home, "key.pem");
      env.runTailscaleCert("gw.example.ts.net", cert, key);
      expect(readFileSync(cert, "utf8")).toBe("CERT");
      expect(readFileSync(key, "utf8")).toBe("KEY");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * Build a fake host environment. Defaults to "nothing installed"; override per
 * test. Never touches the real filesystem, `tailscale`, or `mkcert`.
 */
function fakeEnv(overrides: Partial<TlsProvisionEnv> = {}): TlsProvisionEnv {
  return {
    configDir: "/tmp/omnesis-test-config",
    platform: "linux",
    hasTailscale: () => false,
    tailscaleDnsName: () => "",
    runTailscaleCert: () => {},
    hasMkcert: () => false,
    runMkcert: () => {},
    fileExists: () => false,
    hostname: () => "testhost",
    networkAddresses: () => [],
    isContainer: () => false,
    ...overrides,
  };
}

describe("provisionTls", () => {
  it("Tailscale path: picks the MagicDNS name and writes the right env keys", () => {
    const certCall = vi.fn();
    const env = fakeEnv({
      hasTailscale: () => true,
      tailscaleDnsName: () => "box.tail-scale-example.ts.net",
      runTailscaleCert: certCall,
    });
    const writes: Record<string, string>[] = [];
    const result = provisionTls({ gatewayPort: 7600 }, env, (u) => writes.push(u));

    expect(result.tier).toBe("tailscale");
    expect(result.provisioned).toBe(true);
    expect(certCall).toHaveBeenCalledOnce();
    expect(result.envWritten).toEqual({
      OMNESIS_TLS_CERT: "/tmp/omnesis-test-config/tls/tailscale.crt",
      OMNESIS_TLS_KEY: "/tmp/omnesis-test-config/tls/tailscale.key",
      OMNESIS_GATEWAY_URL: "https://box.tail-scale-example.ts.net:7600",
      OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN: "https://box.tail-scale-example.ts.net:7600",
    });
    expect(result.trustedUrl).toBe("https://box.tail-scale-example.ts.net:7600");
    expect(writes).toHaveLength(1);
  });

  it("mkcert path: used when Tailscale is absent", () => {
    const mk = vi.fn();
    const env = fakeEnv({
      hasMkcert: () => true,
      runMkcert: mk,
      networkAddresses: () => [
        "2001:db8::60",
        "192.0.2.60",
        "192.0.2.60",
        "fe80::60",
        "not-an-address",
      ],
    });
    const result = provisionTls({}, env, () => {});

    expect(result.tier).toBe("mkcert");
    expect(result.provisioned).toBe(true);
    expect(mk).toHaveBeenCalledOnce();
    expect(result.envWritten.OMNESIS_TLS_CERT).toBe("/tmp/omnesis-test-config/tls/mkcert.crt");
    expect(result.envWritten.OMNESIS_TLS_KEY).toBe("/tmp/omnesis-test-config/tls/mkcert.key");
    expect(mk).toHaveBeenCalledWith(
      "/tmp/omnesis-test-config/tls/mkcert.crt",
      "/tmp/omnesis-test-config/tls/mkcert.key",
      ["localhost", "127.0.0.1", "::1", "testhost.local", "192.0.2.60", "2001:db8::60"],
    );
    expect(result.envWritten.OMNESIS_GATEWAY_URL).toBe("https://testhost.local:7600");
  });

  it("falls back to fixed mkcert names when interface enumeration fails", () => {
    const mk = vi.fn();
    const env = fakeEnv({
      hasMkcert: () => true,
      runMkcert: mk,
      networkAddresses: () => {
        throw new Error("interfaces unavailable");
      },
    });

    expect(provisionTls({}, env, () => {}).provisioned).toBe(true);
    expect(mk).toHaveBeenCalledWith(
      "/tmp/omnesis-test-config/tls/mkcert.crt",
      "/tmp/omnesis-test-config/tls/mkcert.key",
      ["localhost", "127.0.0.1", "::1", "testhost.local"],
    );
  });

  it("--mkcert forces mkcert even when Tailscale is available", () => {
    const tsCert = vi.fn();
    const mk = vi.fn();
    const env = fakeEnv({
      hasTailscale: () => true,
      tailscaleDnsName: () => "box.example.ts.net",
      runTailscaleCert: tsCert,
      hasMkcert: () => true,
      runMkcert: mk,
    });
    const result = provisionTls({ mkcert: true }, env, () => {});
    expect(result.tier).toBe("mkcert");
    expect(tsCert).not.toHaveBeenCalled();
    expect(mk).toHaveBeenCalledOnce();
  });

  it("mkcert refresh preserves an installer-selected covered IPv6 URL", () => {
    const result = provisionTls(
      { mkcert: true, force: true, gatewayPort: 7601 },
      fakeEnv({
        hasMkcert: () => true,
        hostname: () => "Studio-Northstar.example.org",
        existingGatewayUrl: "https://[2001:0DB8:0:0:0:0:0:60]:7600/portal/",
        networkAddresses: () => ["2001:db8::60"],
      }),
      () => {},
    );

    expect(result.envWritten.OMNESIS_GATEWAY_URL).toBe("https://[2001:db8::60]:7601");
    expect(result.trustedUrl).toBe("https://[2001:db8::60]:7601");
  });

  it("mkcert refresh replaces an installer-selected address that disappeared", () => {
    const result = provisionTls(
      { mkcert: true, force: true },
      fakeEnv({
        hasMkcert: () => true,
        hostname: () => "Studio-Northstar.example.org",
        existingGatewayUrl: "https://192.0.2.60:7600",
        networkAddresses: () => ["192.0.2.61"],
      }),
      () => {},
    );

    expect(result.envWritten.OMNESIS_GATEWAY_URL).toBe("https://studio-northstar.local:7600");
  });

  it("no-path branch: gives guidance and a non-zero exit code", () => {
    const env = fakeEnv();
    const result = provisionTls({}, env, () => {});
    expect(result.tier).toBe("none");
    expect(result.provisioned).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.messages.join("\n")).toContain("Tailscale");
    expect(result.messages.join("\n")).toContain("mkcert");
    expect(result.messages.join("\n")).toContain("enable HTTPS");
    expect(result.messages.join("\n")).toContain("never joins a network");
  });

  it("a failed tailscale cert names the tailnet settings and permission it needs, and changes nothing", () => {
    const env = fakeEnv({
      hasTailscale: () => true,
      tailscaleDnsName: () => "box.example.ts.net",
      runTailscaleCert: () => {
        throw new Error("HTTPS not enabled");
      },
    });
    const writes: unknown[] = [];
    const result = provisionTls({}, env, (u) => writes.push(u));
    expect(result.tier).toBe("none");
    expect(writes).toHaveLength(0);
    const text = result.messages.join("\n");
    expect(text).toContain("Nothing on your tailnet was changed");
    expect(text).toContain("MagicDNS");
    expect(text).toContain("tailscale set --operator=$USER");

    const mac = provisionTls({}, fakeEnv({ ...env, platform: "darwin" }), () => {});
    expect(mac.messages.join("\n")).not.toContain("--operator");
  });

  describe("tailscaled refusing this account a certificate (Linux)", () => {
    const denied = () =>
      new Error("Command failed: tailscale cert\nAccess denied: cert access denied");

    it("takes the Tailscale operator permission once and mints, like the installer", () => {
      let calls = 0;
      const take = vi.fn(() => true);
      const env = fakeEnv({
        hasTailscale: () => true,
        tailscaleDnsName: () => "box.example.ts.net",
        runTailscaleCert: () => {
          calls += 1;
          if (calls === 1) throw denied();
        },
        takeTailscaleOperator: take,
      });
      const result = provisionTls({}, env, () => {});
      expect(take).toHaveBeenCalledOnce();
      expect(calls).toBe(2);
      expect(result.provisioned).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.messages.join("\n")).toContain("Tailscale operator on this machine only");
    });

    it("names the fix and fails when the permission cannot be taken", () => {
      const env = fakeEnv({
        hasTailscale: () => true,
        tailscaleDnsName: () => "box.example.ts.net",
        runTailscaleCert: () => {
          throw denied();
        },
        takeTailscaleOperator: () => false,
      });
      const writes: unknown[] = [];
      const result = provisionTls({}, env, (u) => writes.push(u));
      expect(result.provisioned).toBe(false);
      expect(result.exitCode).not.toBe(0);
      expect(writes).toHaveLength(0);
      expect(result.messages.join("\n")).toContain("sudo tailscale set --operator=$USER");
    });

    it("asks for nothing on another failure, or on macOS", () => {
      const take = vi.fn(() => true);
      const failing = (error: Error) =>
        fakeEnv({
          hasTailscale: () => true,
          tailscaleDnsName: () => "box.example.ts.net",
          runTailscaleCert: () => {
            throw error;
          },
          takeTailscaleOperator: take,
        });
      expect(provisionTls({}, failing(new Error("HTTPS not enabled")), () => {}).provisioned).toBe(
        false,
      );
      const mac = { ...failing(denied()), platform: "darwin" as const };
      expect(provisionTls({}, mac, () => {}).provisioned).toBe(false);
      expect(take).not.toHaveBeenCalled();
    });
  });

  it("Tailscale without a MagicDNS name says what enables one before falling back", () => {
    const env = fakeEnv({ hasTailscale: () => true, tailscaleDnsName: () => "" });
    const result = provisionTls({}, env, () => {});
    expect(result.tier).toBe("none");
    const text = result.messages.join("\n");
    expect(text).toContain("needs MagicDNS");
    expect(text).toContain("Tailscale is running");
    expect(text).not.toContain("tailscale up");
  });

  it("refuses to clobber an existing user-provided cert without --force", () => {
    const env = fakeEnv({
      existingCertPath: "/byo/cert.pem",
      fileExists: (p) => p === "/byo/cert.pem",
      hasMkcert: () => true,
    });
    const writes: unknown[] = [];
    const result = provisionTls({}, env, (u) => writes.push(u));
    expect(result.provisioned).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.messages.join("\n")).toContain("--force");
    expect(writes).toHaveLength(0);
  });

  it("--force overwrites an existing user-provided cert", () => {
    const mk = vi.fn();
    const env = fakeEnv({
      existingCertPath: "/byo/cert.pem",
      fileExists: (p) => p === "/byo/cert.pem",
      hasMkcert: () => true,
      runMkcert: mk,
    });
    const result = provisionTls({ force: true }, env, () => {});
    expect(result.tier).toBe("mkcert");
    expect(mk).toHaveBeenCalledOnce();
  });

  it("does not re-mint when a cert already exists at the target path (idempotent), still wiring env", () => {
    const tsCert = vi.fn();
    const certPath = "/tmp/omnesis-test-config/tls/tailscale.crt";
    const env = fakeEnv({
      hasTailscale: () => true,
      tailscaleDnsName: () => "box.example.ts.net",
      runTailscaleCert: tsCert,
      // The provisioned cert exists, but no user-provided OMNESIS_TLS_CERT.
      fileExists: (p) => p === certPath,
    });
    const result = provisionTls({}, env, () => {});
    expect(tsCert).not.toHaveBeenCalled(); // already there, not re-minted
    expect(result.provisioned).toBe(true);
    expect(result.envWritten.OMNESIS_TLS_CERT).toBe(certPath);
  });

  it("--force re-mints even when the cert already exists at the target path", () => {
    const tsCert = vi.fn();
    const certPath = "/tmp/omnesis-test-config/tls/tailscale.crt";
    const env = fakeEnv({
      hasTailscale: () => true,
      tailscaleDnsName: () => "box.example.ts.net",
      runTailscaleCert: tsCert,
      fileExists: (p) => p === certPath,
    });
    provisionTls({ force: true }, env, () => {});
    expect(tsCert).toHaveBeenCalledOnce();
  });

  it("dry-run: writes nothing and reports the plan", () => {
    const tsCert = vi.fn();
    const env = fakeEnv({
      hasTailscale: () => true,
      tailscaleDnsName: () => "box.example.ts.net",
      runTailscaleCert: tsCert,
    });
    const writes: unknown[] = [];
    const result = provisionTls({ dryRun: true }, env, (u) => writes.push(u));
    expect(tsCert).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(result.envWritten).toEqual({});
    expect(result.messages.join("\n")).toContain("Would mint");
  });

  it("container: refuses and points at the mount-the-PEMs workflow", () => {
    const env = fakeEnv({ isContainer: () => true, hasMkcert: () => true });
    const result = provisionTls({}, env, () => {});
    expect(result.provisioned).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.messages.join("\n").toLowerCase()).toContain("container");
    expect(result.messages.join("\n")).toContain("--tls-cert and --tls-key");
  });

  it("tailscale cert failure degrades gracefully without writing env", () => {
    const env = fakeEnv({
      hasTailscale: () => true,
      tailscaleDnsName: () => "box.example.ts.net",
      runTailscaleCert: () => {
        throw new Error("HTTPS not enabled");
      },
    });
    const writes: unknown[] = [];
    const result = provisionTls({}, env, (u) => writes.push(u));
    expect(result.tier).toBe("none");
    expect(result.provisioned).toBe(false);
    expect(writes).toHaveLength(0);
    expect(result.messages.join("\n")).toContain("HTTPS");
  });
});

describe("mkcertNetworkAddresses", () => {
  it("keeps valid remote IPs in stable order and removes duplicates and link-local IPv6", () => {
    expect(
      mkcertNetworkAddresses([
        "2001:db8::60",
        "192.0.2.60",
        "fe80::60",
        "fe90::60",
        "2001:db8::60%eth0",
        "0.0.0.0",
        "::ffff:127.0.0.2",
        "192.0.2.60",
        "invalid",
      ]),
    ).toEqual(["192.0.2.60", "2001:db8::60"]);
  });
});

describe("mkcertGatewayUrl", () => {
  it("uses the normalized local hostname when no covered URL was saved", () => {
    expect(mkcertGatewayUrl(undefined, "studio-northstar.local", [], 7600)).toBe(
      "https://studio-northstar.local:7600",
    );
  });

  it.each([
    "https://localhost:7601",
    "https://studio.localhost:7601",
    "https://127.0.0.2:7601",
    "https://[::1]:7601",
  ])("replaces loopback URL %s with the covered remote hostname", (existingUrl) => {
    expect(mkcertGatewayUrl(existingUrl, "studio-northstar.local", ["192.0.2.60"], 7600)).toBe(
      "https://studio-northstar.local:7600",
    );
  });

  it.each([
    ["https://studio-northstar.local:7601", "https://studio-northstar.local:7600"],
    ["https://192.0.2.60:7601", "https://192.0.2.60:7600"],
  ])("preserves covered remote URL %s", (existingUrl, expected) => {
    expect(mkcertGatewayUrl(existingUrl, "studio-northstar.local", ["192.0.2.60"], 7600)).toBe(
      expected,
    );
  });
});

describe("phoneRepairLines", () => {
  const phones = [
    { name: "Maya's iPhone", kind: "ios" as const },
    { name: "pixel-8", kind: "android" as const },
  ];
  const selfSigned = { fingerprint: "a".repeat(64), selfSigned: true };
  const changed = { activated: true as const, fingerprintSha256: "b".repeat(64) };
  // Colors are ANSI escapes in a terminal; strip them to read the words.
  // eslint-disable-next-line no-control-regex
  const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/gu, "");

  it("after a self-signed certificate, says every phone stops and gives a repair command each", () => {
    const text = plain(phoneRepairLines(selfSigned, changed, phones));
    expect(text).toContain("Your paired phones stop connecting now");
    expect(text).toContain(`Maya's iPhone (iPhone): omnesis devices repair 'Maya'\\''s iPhone'`);
    expect(text).toContain("pixel-8 (Android): omnesis devices repair pixel-8");
    expect(text).toContain("choose Repair on each phone");
  });

  it("after a trusted certificate, names the phones as possibly affected", () => {
    const text = plain(phoneRepairLines({ ...selfSigned, selfSigned: false }, changed, phones));
    expect(text).toContain("A phone paired on a home-network address stops connecting now");
    expect(text.replace(/\s+/g, " ")).toContain("one paired on the trusted name keeps working");
  });

  it("says the change lands at restart when the certificate is not active yet", () => {
    expect(plain(phoneRepairLines(selfSigned, { activated: false }, phones))).toContain(
      "once the gateway restarts",
    );
  });

  it("says nothing when the certificate is unchanged or no phone is paired", () => {
    const same = { activated: true as const, fingerprintSha256: selfSigned.fingerprint };
    expect(phoneRepairLines(selfSigned, same, phones)).toEqual([]);
    expect(phoneRepairLines(selfSigned, changed, [])).toEqual([]);
  });
});
