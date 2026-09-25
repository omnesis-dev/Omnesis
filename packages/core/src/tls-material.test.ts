// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  certificateCoversHost,
  certificateNames,
  inspectTlsMaterial,
  resolveTlsMaterial,
} from "./tls-material.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const dir = mkdtempSync(join(tmpdir(), "omnesis-tls-material-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A self-signed pair covering the given names, valid for `days` from now. */
function mint(name: string, days: number, sans: string[]): { cert: string; key: string } {
  const cnf = join(dir, `${name}.cnf`);
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
      join(dir, `${name}.key`),
      "-out",
      join(dir, `${name}.crt`),
      "-config",
      cnf,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return {
    cert: readFileSync(join(dir, `${name}.crt`), "utf8"),
    key: readFileSync(join(dir, `${name}.key`), "utf8"),
  };
}

const pair = mint("gateway", 90, ["DNS:localhost", "DNS:*.tail.example", "IP:127.0.0.1"]);
const other = mint("other", 90, ["DNS:localhost"]);
const notBefore = Date.parse(new X509Certificate(pair.cert).validFrom);
const notAfter = Date.parse(new X509Certificate(pair.cert).validTo);

describe("inspectTlsMaterial", () => {
  test("a certificate inside its validity window, past the renewal band, is valid", () => {
    const inspection = inspectTlsMaterial({
      certPem: pair.cert,
      keyPem: pair.key,
      now: notBefore + DAY_MS,
      renewBeforeDays: 30,
    });
    expect(inspection.state).toBe("valid");
    expect(inspection.selfSigned).toBe(true);
    expect(inspection.daysRemaining).toBe(89);
    expect(inspection.names).toEqual(["localhost", "*.tail.example", "127.0.0.1"]);
    expect(inspection.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(inspection.notAfter).toBe(new Date(notAfter).toISOString());
  });

  test("the clock decides expiring, expired and not-yet-valid", () => {
    const at = (now: number) =>
      inspectTlsMaterial({ certPem: pair.cert, now, renewBeforeDays: 30 }).state;
    expect(at(notAfter - 29 * DAY_MS)).toBe("expiring");
    expect(at(notAfter - 30 * DAY_MS)).toBe("expiring");
    expect(at(notAfter)).toBe("expired");
    expect(at(notAfter + 5 * DAY_MS)).toBe("expired");
    expect(at(notBefore - 60_000)).toBe("not-yet-valid");
    const expired = inspectTlsMaterial({
      certPem: pair.cert,
      now: notAfter + 5 * DAY_MS,
      renewBeforeDays: 30,
    });
    expect(expired.daysRemaining).toBe(-5);
  });

  test("a key that belongs to another certificate is a mismatch, whatever the dates say", () => {
    const inspection = inspectTlsMaterial({
      certPem: pair.cert,
      keyPem: other.key,
      now: notAfter + DAY_MS,
      renewBeforeDays: 30,
    });
    expect(inspection.state).toBe("key-mismatch");
    expect(inspection.error).toMatch(/does not belong/u);
    expect(inspection.fingerprintSha256).not.toBeNull();
  });

  test("text that is not a certificate, or a key that is not a key, is unreadable", () => {
    const unreadable = inspectTlsMaterial({
      certPem: "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n",
      now: Date.now(),
      renewBeforeDays: 30,
    });
    expect(unreadable.state).toBe("unreadable");
    expect(unreadable.error).toMatch(/did not parse/u);
    expect(unreadable.fingerprintSha256).toBeNull();

    const badKey = inspectTlsMaterial({
      certPem: pair.cert,
      keyPem: "not a key",
      now: notBefore + DAY_MS,
      renewBeforeDays: 30,
    });
    expect(badKey.state).toBe("key-mismatch");
    expect(badKey.error).toMatch(/private key did not parse/u);
  });

  test("names the gateway is reached at are checked against DNS, wildcard and IP entries", () => {
    const inspection = inspectTlsMaterial({
      certPem: pair.cert,
      now: notBefore + DAY_MS,
      renewBeforeDays: 30,
      requiredHosts: [
        "localhost",
        "LOCALHOST.",
        "gw.tail.example",
        "deep.gw.tail.example",
        "127.0.0.1",
        "[::1]",
        "omnesis.local",
        "",
      ],
    });
    expect(inspection.state).toBe("valid");
    expect(inspection.uncoveredHosts).toEqual(["deep.gw.tail.example", "::1", "omnesis.local"]);
  });
});

describe("certificate helpers", () => {
  test("certificateNames strips the tags and keeps the order written in the certificate", () => {
    expect(certificateNames(new X509Certificate(other.cert))).toEqual(["localhost"]);
  });

  test("certificateCoversHost treats an empty host as covered and brackets an IPv6 literal", () => {
    const cert = new X509Certificate(pair.cert);
    expect(certificateCoversHost(cert, "")).toBe(true);
    expect(certificateCoversHost(cert, "[127.0.0.1]")).toBe(true);
    expect(certificateCoversHost(cert, "[::1]")).toBe(false);
  });
});

describe("resolveTlsMaterial", () => {
  const configDir = "/srv/omnesis";

  test("no env override means the gateway's own self-signed pair", () => {
    expect(resolveTlsMaterial({ configDir })).toEqual({
      ownership: "self-signed",
      certPath: "/srv/omnesis/tls/cert.pem",
      keyPath: "/srv/omnesis/tls/key.pem",
    });
    expect(resolveTlsMaterial({ configDir, certPath: "/x.crt" }).ownership).toBe("self-signed");
  });

  test("the installer tiers are recognised by their paths, however they are spelled", () => {
    expect(
      resolveTlsMaterial({
        configDir,
        certPath: "/srv/omnesis/tls/../tls/tailscale.crt",
        keyPath: "/srv/omnesis/tls/tailscale.key",
      }),
    ).toEqual({
      ownership: "tailscale",
      certPath: "/srv/omnesis/tls/tailscale.crt",
      keyPath: "/srv/omnesis/tls/tailscale.key",
    });
    expect(
      resolveTlsMaterial({
        configDir,
        certPath: "/srv/omnesis/tls/mkcert.crt",
        keyPath: "/srv/omnesis/tls/mkcert.key",
      }).ownership,
    ).toBe("mkcert");
    expect(
      resolveTlsMaterial({
        configDir,
        certPath: "/srv/omnesis/tls/cert.pem",
        keyPath: "/srv/omnesis/tls/key.pem",
      }).ownership,
    ).toBe("self-signed");
  });

  test("a tier's certificate beside a foreign key is the operator's, as is any other path", () => {
    expect(
      resolveTlsMaterial({
        configDir,
        certPath: "/srv/omnesis/tls/tailscale.crt",
        keyPath: "/etc/ssl/private/gateway.key",
      }).ownership,
    ).toBe("external");
    expect(
      resolveTlsMaterial({
        configDir,
        certPath: "/etc/letsencrypt/live/gw/fullchain.pem",
        keyPath: "/etc/letsencrypt/live/gw/privkey.pem",
      }).ownership,
    ).toBe("external");
  });
});
