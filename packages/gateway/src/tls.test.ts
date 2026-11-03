// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";

import {
  directProcessLauncher,
  processLauncher,
  setProcessLauncher,
  type ProcessLauncher,
} from "./process-launcher/index.js";
import {
  fingerprintFromCertPem,
  generateSelfSigned,
  parseTlsExtraNames,
  resolveTlsBundle,
  tlsExtraHostNames,
} from "./tls.js";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "omnesis-tls-test-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("resolveTlsBundle", () => {
  test("a self-signed pair that does not belong together is minted again; a user-provided one is refused", async () => {
    const a = await resolveTlsBundle({ configDir });
    const otherDir = mkdtempSync(join(tmpdir(), "omnesis-tls-other-"));
    try {
      const b = await resolveTlsBundle({ configDir: otherDir });
      writeFileSync(join(configDir, "tls", "key.pem"), b.key);
      const again = await resolveTlsBundle({ configDir });
      expect(again.fingerprintSha256).not.toBe(a.fingerprintSha256);
      expect(again.source).toBe("auto-generated");
      expect(readFileSync(join(configDir, "tls", "cert.pem"), "utf8")).toBe(again.cert);

      await expect(
        resolveTlsBundle({
          configDir,
          envCertPath: join(configDir, "tls", "cert.pem"),
          envKeyPath: join(otherDir, "tls", "key.pem"),
        }),
      ).rejects.toThrow(/does not belong together/u);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test("generates and persists a fresh bundle when files don't exist", async () => {
    const b = await resolveTlsBundle({ configDir });

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

  test("reuses the existing bundle on subsequent calls (idempotent)", async () => {
    const a = await resolveTlsBundle({ configDir });
    const b = await resolveTlsBundle({ configDir });
    expect(a.fingerprintSha256).toBe(b.fingerprintSha256);
    expect(a.cert).toBe(b.cert);
    expect(a.key).toBe(b.key);
    expect(b.source).toBe("auto-generated");
  });

  test("env-path overrides load exactly that cert (source=user-provided)", async () => {
    // Generate a stable bundle in a *different* config dir, then point the
    // env paths at those files and prove resolveTlsBundle picks them up
    // without touching configDir.
    const otherDir = mkdtempSync(join(tmpdir(), "omnesis-tls-other-"));
    try {
      const seed = await resolveTlsBundle({ configDir: otherDir });
      const certPath = join(otherDir, "tls", "cert.pem");
      const keyPath = join(otherDir, "tls", "key.pem");

      const b = await resolveTlsBundle({
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

  test("fingerprint matches `openssl x509 -fingerprint -sha256`", async () => {
    const b = await resolveTlsBundle({ configDir });
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

  test("persisted files are mode 0600 (POSIX hosts)", async () => {
    if (process.platform === "win32") return; // mode bits are nominal on Windows
    await resolveTlsBundle({ configDir });
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

  test("names the same hosts without their SAN tags, for the addresses phones are offered", () => {
    expect(tlsExtraHostNames("Studio-Northstar., 192.0.2.47, 2001:db8::7, 127.0.0.1, x y")).toEqual(
      ["studio-northstar", "192.0.2.47", "2001:db8::7"],
    );
    expect(tlsExtraHostNames(undefined)).toEqual([]);
  });

  test("a newly minted certificate covers the valid names", async () => {
    const b = await resolveTlsBundle({
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

  test("an existing certificate is not re-minted for names it does not cover", async () => {
    const first = await resolveTlsBundle({ configDir });
    const again = await resolveTlsBundle({ configDir, envExtraNames: "studio-northstar.local" });
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
  test("auto-generated bundle is the only one that triggers the nudge", async () => {
    const generated = await resolveTlsBundle({ configDir });
    expect(generated.source).toBe("auto-generated");

    const otherDir = mkdtempSync(join(tmpdir(), "omnesis-tls-nudge-"));
    try {
      const seed = await resolveTlsBundle({ configDir: otherDir });
      const provisioned = await resolveTlsBundle({
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

describe("generateSelfSigned off the event loop", () => {
  test("runs openssl through the process launcher and lets the loop turn while it does", async () => {
    const before = processLauncher();
    const programs: string[] = [];
    const recording: ProcessLauncher = {
      run: (command, args, opts) => {
        programs.push(command);
        return directProcessLauncher.run(command, args, opts);
      },
    };
    setProcessLauncher(recording);
    let turns = 0;
    const ticker = setInterval(() => turns++, 1);
    try {
      const generated = await generateSelfSigned();
      expect(new X509Certificate(generated.cert).subject).toContain("Omnesis Gateway");
      expect(fingerprintFromCertPem(generated.cert)).toBe(generated.fingerprintSha256);
    } finally {
      clearInterval(ticker);
      setProcessLauncher(before);
    }
    expect(programs).toEqual(["openssl"]);
    // Key generation outlasts a millisecond timer, so an awaited program lets
    // it fire; a synchronous spawn would hold every turn until it returned.
    expect(turns).toBeGreaterThan(0);
  });

  test("a launcher failure surfaces as an error naming openssl", async () => {
    const before = processLauncher();
    setProcessLauncher({
      run: () =>
        Promise.resolve({
          exitCode: 1,
          signal: null,
          stdout: new Uint8Array(),
          stderr: "unknown option -x509",
        }),
    });
    try {
      await expect(resolveTlsBundle({ configDir })).rejects.toThrow(
        /openssl could not generate the self-signed certificate: it exited with code 1: unknown option -x509/u,
      );
      expect(existsSync(join(configDir, "tls", "cert.pem"))).toBe(false);
    } finally {
      setProcessLauncher(before);
    }
  });
});

describe("fingerprintFromCertPem", () => {
  test("recomputes the same hex digest as direct DER hashing", async () => {
    const b = await resolveTlsBundle({ configDir });
    const cert = new X509Certificate(b.cert);
    const direct = createHash("sha256").update(cert.raw).digest("hex");
    expect(fingerprintFromCertPem(b.cert)).toBe(direct);
    expect(direct).toMatch(/^[0-9a-f]{64}$/);
  });

  test("throws on garbage input", () => {
    expect(() => fingerprintFromCertPem("not-a-pem")).toThrow();
  });

  test("hand-fed PEM round-trips", async () => {
    const b = await resolveTlsBundle({ configDir });
    const certCopyPath = join(configDir, "copy.pem");
    writeFileSync(certCopyPath, b.cert);
    const copy = readFileSync(certCopyPath, "utf8");
    expect(fingerprintFromCertPem(copy)).toBe(b.fingerprintSha256);
  });
});
