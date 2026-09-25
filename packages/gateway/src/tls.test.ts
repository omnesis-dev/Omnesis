// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";

import { fingerprintFromCertPem, parseTlsExtraNames, resolveTlsBundle } from "./tls.js";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "omnesis-tls-test-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("resolveTlsBundle", () => {
  test("a self-signed pair that does not belong together is minted again; a user-provided one is refused", () => {
    const a = resolveTlsBundle({ configDir });
    const otherDir = mkdtempSync(join(tmpdir(), "omnesis-tls-other-"));
    try {
      const b = resolveTlsBundle({ configDir: otherDir });
      writeFileSync(join(configDir, "tls", "key.pem"), b.key);
      const again = resolveTlsBundle({ configDir });
      expect(again.fingerprintSha256).not.toBe(a.fingerprintSha256);
      expect(again.source).toBe("auto-generated");
      expect(readFileSync(join(configDir, "tls", "cert.pem"), "utf8")).toBe(again.cert);

      expect(() =>
        resolveTlsBundle({
          configDir,
          envCertPath: join(configDir, "tls", "cert.pem"),
          envKeyPath: join(otherDir, "tls", "key.pem"),
        }),
      ).toThrow(/does not belong together/u);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test("generates and persists a fresh bundle when files don't exist", () => {
    const b = resolveTlsBundle({ configDir });

    expect(b.source).toBe("auto-generated");
    expect(b.cert).toContain("BEGIN CERTIFICATE");
    expect(b.key).toMatch(/BEGIN (RSA |EC |)PRIVATE KEY/);
    expect(b.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);

    expect(existsSync(join(configDir, "tls", "cert.pem"))).toBe(true);
    expect(existsSync(join(configDir, "tls", "key.pem"))).toBe(true);

    // Cert content sanity: subject, SAN, validity ≥ ~10 years.
    const x = new X509Certificate(b.cert);
    expect(x.subject).toContain("Omnesis Gateway");
    expect(x.subjectAltName).toContain("DNS:localhost");
    expect(x.subjectAltName).toContain("IP Address:127.0.0.1");
    const notBefore = new Date(x.validFrom).getTime();
    const notAfter = new Date(x.validTo).getTime();
    const years = (notAfter - notBefore) / (365.25 * 24 * 3600 * 1000);
    expect(years).toBeGreaterThanOrEqual(9.9);
  });

  test("reuses the existing bundle on subsequent calls (idempotent)", () => {
    const a = resolveTlsBundle({ configDir });
    const b = resolveTlsBundle({ configDir });
    expect(a.fingerprintSha256).toBe(b.fingerprintSha256);
    expect(a.cert).toBe(b.cert);
    expect(a.key).toBe(b.key);
    expect(b.source).toBe("auto-generated");
  });

  test("env-path overrides load exactly that cert (source=user-provided)", () => {
    // Generate a stable bundle in a *different* config dir, then point the
    // env paths at those files and prove resolveTlsBundle picks them up
    // without touching configDir.
    const otherDir = mkdtempSync(join(tmpdir(), "omnesis-tls-other-"));
    try {
      const seed = resolveTlsBundle({ configDir: otherDir });
      const certPath = join(otherDir, "tls", "cert.pem");
      const keyPath = join(otherDir, "tls", "key.pem");

      const b = resolveTlsBundle({
        configDir,
        envCertPath: certPath,
        envKeyPath: keyPath,
      });
      expect(b.source).toBe("user-provided");
      expect(b.fingerprintSha256).toBe(seed.fingerprintSha256);
      // Did NOT touch configDir/tls (no auto-gen).
      expect(existsSync(join(configDir, "tls"))).toBe(false);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test("fingerprint matches `openssl x509 -fingerprint -sha256`", () => {
    const b = resolveTlsBundle({ configDir });
    const certPath = join(configDir, "tls", "cert.pem");
    const out = execFileSync("openssl", [
      "x509",
      "-in",
      certPath,
      "-fingerprint",
      "-sha256",
      "-noout",
    ]).toString();
    // Output: "sha256 Fingerprint=AB:CD:..."
    const stripped = out.split("=")[1]!.trim().replace(/:/g, "").toLowerCase();
    expect(stripped).toBe(b.fingerprintSha256);
  });

  test("persisted files are mode 0600 (POSIX hosts)", () => {
    if (process.platform === "win32") return; // mode bits are nominal on Windows
    resolveTlsBundle({ configDir });
    const certMode = statSync(join(configDir, "tls", "cert.pem")).mode & 0o777;
    const keyMode = statSync(join(configDir, "tls", "key.pem")).mode & 0o777;
    expect(certMode).toBe(0o600);
    expect(keyMode).toBe(0o600);
  });
});

describe("OMNESIS_TLS_EXTRA_NAMES", () => {
  test("keeps hostnames and routable IPs, and drops everything else", () => {
    expect(
      parseTlsExtraNames(
        " studio-northstar , Studio-Northstar.local., 192.0.2.47,2001:db8::7," +
          "127.0.0.1,fe80::1,::1,0.0.0.0,*.example.com,-bad,bad_label,a..b,DNS:evil,x y,," +
          `${"a".repeat(64)}.local`,
      ),
    ).toEqual([
      "DNS:studio-northstar",
      "DNS:studio-northstar.local",
      "IP:192.0.2.47",
      "IP:2001:db8::7",
    ]);
    expect(parseTlsExtraNames(undefined)).toEqual([]);
    expect(parseTlsExtraNames("")).toEqual([]);
  });

  test("a newly minted certificate covers the valid names", () => {
    const b = resolveTlsBundle({
      configDir,
      envExtraNames: "studio-northstar,studio-northstar.local,192.0.2.47,2001:db8::7,not valid",
    });
    const san = new X509Certificate(b.cert).subjectAltName ?? "";
    expect(san).toContain("DNS:studio-northstar,");
    expect(san).toContain("DNS:studio-northstar.local");
    expect(san).toContain("IP Address:192.0.2.47");
    expect(san).toContain("IP Address:2001:DB8:0:0:0:0:0:7");
    // The fixed names stay.
    expect(san).toContain("DNS:localhost");
    expect(san).toContain("DNS:gateway");
    expect(san).not.toContain("not valid");
  });

  test("an existing certificate is not re-minted for names it does not cover", () => {
    const first = resolveTlsBundle({ configDir });
    const again = resolveTlsBundle({ configDir, envExtraNames: "studio-northstar.local" });
    expect(again.fingerprintSha256).toBe(first.fingerprintSha256);
    expect(new X509Certificate(again.cert).subjectAltName).not.toContain(
      "DNS:studio-northstar.local",
    );
  });
});

describe("self-signed nudge signal", () => {
  // The gateway boots a one-line nudge toward `omnesis tls provision` only when
  // it is serving its own self-signed cert (source "auto-generated"). It must
  // stay silent for an operator-provisioned (user-provided) cert, so the nudge
  // predicate is exactly `source === "auto-generated"`.
  test("auto-generated bundle is the only one that triggers the nudge", () => {
    const generated = resolveTlsBundle({ configDir });
    expect(generated.source).toBe("auto-generated");

    const otherDir = mkdtempSync(join(tmpdir(), "omnesis-tls-nudge-"));
    try {
      const seed = resolveTlsBundle({ configDir: otherDir });
      const provisioned = resolveTlsBundle({
        configDir,
        envCertPath: join(otherDir, "tls", "cert.pem"),
        envKeyPath: join(otherDir, "tls", "key.pem"),
      });
      expect(seed.source).toBe("auto-generated");
      expect(provisioned.source).toBe("user-provided");

      const nudges = (b: { source: string }) => b.source === "auto-generated";
      expect(nudges(generated)).toBe(true);
      expect(nudges(provisioned)).toBe(false);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

describe("fingerprintFromCertPem", () => {
  test("recomputes the same hex digest as direct DER hashing", () => {
    const b = resolveTlsBundle({ configDir });
    const cert = new X509Certificate(b.cert);
    const direct = createHash("sha256").update(cert.raw).digest("hex");
    expect(fingerprintFromCertPem(b.cert)).toBe(direct);
    expect(direct).toMatch(/^[0-9a-f]{64}$/);
  });

  test("throws on garbage input", () => {
    expect(() => fingerprintFromCertPem("not-a-pem")).toThrow();
  });

  test("hand-fed PEM round-trips", () => {
    const b = resolveTlsBundle({ configDir });
    const certCopyPath = join(configDir, "copy.pem");
    writeFileSync(certCopyPath, b.cert);
    const copy = readFileSync(certCopyPath, "utf8");
    expect(fingerprintFromCertPem(copy)).toBe(b.fingerprintSha256);
  });
});
