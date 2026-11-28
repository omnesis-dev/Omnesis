// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { X509Certificate, createHash, createPrivateKey } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import * as core from "@omnesis/core";
import { TlsIssuerCleanupUnconfirmedError } from "./tls-lifecycle/issuer-cleanup.js";

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
  core.clearSecretFileKeyCacheForTests();
  vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  configDir = mkdtempSync(join(tmpdir(), "omnesis-tls-test-"));
});

afterEach(() => {
  core.clearSecretFileKeyCacheForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
  test.skipIf(process.platform === "win32")(
    "managed certificate generation signs an in-memory key without the plaintext-key launcher",
    async () => {
      vi.stubEnv("OMNESIS_DESKTOP_MANAGED", "1");
      const before = processLauncher();
      const run = vi.fn(async () => {
        throw new Error("Plaintext key staging was called");
      });
      setProcessLauncher({ run });
      try {
        const generated = await generateSelfSigned();
        const certificate = new X509Certificate(generated.cert);
        expect(certificate.checkPrivateKey(createPrivateKey(generated.key))).toBe(true);
        expect(run).not.toHaveBeenCalled();
      } finally {
        setProcessLauncher(before);
      }
    },
  );
  test("gateway shutdown cancels first-install certificate generation without persisting partial material", async () => {
    const before = processLauncher();
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    setProcessLauncher({
      async run(_command, _args, options) {
        expect(options.signal).toBe(controller.signal);
        entered();
        await new Promise<void>((resolve) =>
          options.signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { exitCode: null, signal: "SIGTERM", stdout: new Uint8Array(), stderr: "" };
      },
    });
    try {
      const generation = resolveTlsBundle({ configDir, signal: controller.signal });
      const rejected = expect(generation).rejects.toThrow("killed by SIGTERM");
      await started;
      controller.abort();
      await rejected;
      expect(existsSync(join(configDir, "tls", "cert.pem"))).toBe(false);
      expect(existsSync(join(configDir, "tls", "key.pem"))).toBe(false);
    } finally {
      setProcessLauncher(before);
    }
  });

  test("a pre-aborted boot does not start certificate preparation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(resolveTlsBundle({ configDir, signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(existsSync(join(configDir, "tls"))).toBe(false);
  });

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

test("startup decrypts scope-bound key envelopes on every platform and keeps certificate PEM public", async () => {
  vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  await core.ensureInstallRootKey({ backend: "file", configDir });
  await core.primeSecretFileKeyCache({ backend: "file", configDir });
  const first = await resolveTlsBundle({ configDir });
  const serialized = readFileSync(join(configDir, "tls", "key.pem"), "utf8");
  expect(core.isEncryptedSecretFile(serialized)).toBe(true);
  expect(serialized).not.toContain("BEGIN PRIVATE KEY");
  expect(core.secretFileEncryptionRequired(configDir)).toBe(true);
  expect(readFileSync(join(configDir, "tls", "cert.pem"), "utf8")).toBe(first.cert);
  expect((await resolveTlsBundle({ configDir })).key).toBe(first.key);
  const explicit = await resolveTlsBundle({
    configDir,
    envKeyPath: join(configDir, "tls", "key.pem"),
    envCertPath: join(configDir, "tls", "cert.pem"),
  });
  expect(explicit.source).toBe("user-provided");
  expect(explicit.key).toBe(first.key);
});

test.skipIf(process.platform !== "win32")(
  "Windows generation protects the scratch directory before OpenSSL writes its private key",
  async () => {
    const previous = processLauncher();
    const direct = directProcessLauncher;
    let checked = false;
    setProcessLauncher({
      ...direct,
      async run(file, args, options) {
        const key = args[args.indexOf("-keyout") + 1]!;
        const parent = join(key, "..");
        expect(core.inspectWindowsPrivatePathSync(parent, "directory").private).toBe(true);
        expect(existsSync(key)).toBe(false);
        const result = await direct.run(file, args, options);
        if (result.exitCode === 0)
          expect(core.inspectWindowsPrivatePathSync(key, "file").private).toBe(true);
        checked = true;
        return result;
      },
    });
    try {
      await resolveTlsBundle({ configDir });
      expect(checked).toBe(true);
      for (const name of ["key.pem", "cert.pem"]) {
        expect(
          core.inspectWindowsPrivatePathSync(join(configDir, "tls", name), "file").private,
        ).toBe(true);
      }
    } finally {
      setProcessLauncher(previous);
    }
  },
);

test.each([undefined, new Error("Invented join failure")])(
  "an unconfirmed self-signed issuer retains its owned private scratch instead of reporting ordinary failure cleanup (%s)",
  async (failure) => {
    const before = processLauncher();
    let scratch: string | undefined;
    setProcessLauncher({
      run: (_file, args) => {
        const keyPath = args[args.indexOf("-keyout") + 1]!;
        scratch = join(keyPath, "..");
        writeFileSync(keyPath, "invented partial private key");
        return Promise.resolve(
          Object.assign(
            {
              exitCode: null,
              signal: null,
              stdout: Buffer.alloc(0),
              stderr: "",
              failure: "spawn" as const,
            },
            { cleanupFailure: failure },
          ),
        );
      },
    });
    try {
      const error = await generateSelfSigned().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(TlsIssuerCleanupUnconfirmedError);
      expect(error).toMatchObject({ cleanupFailure: failure, scratchDirectory: scratch });
      expect(existsSync(scratch!)).toBe(true);
      expect(readFileSync(join(scratch!, "key.pem"), "utf8")).toBe("invented partial private key");
    } finally {
      setProcessLauncher(before);
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  },
);
