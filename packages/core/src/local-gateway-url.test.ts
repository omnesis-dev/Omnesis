// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import {
  localGatewayRequestUrl,
  servedCertificateCoversHost,
  servedCertificateCoversLocalhost,
} from "./local-gateway-url.js";
import type { GatewayLockHolder } from "./gateway-lock.js";

// Throwaway self-signed certificates: one naming localhost and 127.0.0.1, one
// naming only a fictional tailnet host.
const LOOPBACK_CERT = `-----BEGIN CERTIFICATE-----
MIICSzCCAfGgAwIBAgIJAL2zNn7oqVrsMAoGCCqGSM49BAMCMCAxHjAcBgNVBAMM
FU9tbmVzaXMgVGVzdCBsb29wYmFjazAgFw0yNjA5MTUxNzU4MDRaGA8yMTI2MDgy
MjE3NTgwNFowIDEeMBwGA1UEAwwVT21uZXNpcyBUZXN0IGxvb3BiYWNrMIIBSzCC
AQMGByqGSM49AgEwgfcCAQEwLAYHKoZIzj0BAQIhAP////8AAAABAAAAAAAAAAAA
AAAA////////////////MFsEIP////8AAAABAAAAAAAAAAAAAAAA////////////
///8BCBaxjXYqjqT57PrvVV2mIa8ZR0GsMxTsPY7zjw+J9JgSwMVAMSdNgiG5wST
amZ44ROdJreBn36QBEEEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP
40Li/hp/m47n60p8D54WK84zV2sxXs7LtkBoN79R9QIhAP////8AAAAA////////
//+85vqtpxeehPO5ysL8YyVRAgEBA0IABBY/a6RK2+DpAsgH7CxVRILKufGH8ARs
SSMcbNPmSRr3yJ3CQsQDaLcK+VvFid7h8Kt619Nvi00Z6D5AfCzfTCmjHjAcMBoG
A1UdEQQTMBGCCWxvY2FsaG9zdIcEfwAAATAKBggqhkjOPQQDAgNIADBFAiBWBtIO
8zfVx1B58GLtheDUeMrMTBrlT3Rcs414SeQ90AIhAM6dND3xFhB2fGJui6Omy+gz
8YUFzOm/aJhDgXliRsxj
-----END CERTIFICATE-----
`;
const TAILNET_CERT = `-----BEGIN CERTIFICATE-----
MIICVjCCAf2gAwIBAgIJAPlKCjy5hqhxMAoGCCqGSM49BAMCMB8xHTAbBgNVBAMM
FE9tbmVzaXMgVGVzdCB0YWlsbmV0MCAXDTI2MDkxNTE3NTgwNFoYDzIxMjYwODIy
MTc1ODA0WjAfMR0wGwYDVQQDDBRPbW5lc2lzIFRlc3QgdGFpbG5ldDCCAUswggED
BgcqhkjOPQIBMIH3AgEBMCwGByqGSM49AQECIQD/////AAAAAQAAAAAAAAAAAAAA
AP///////////////zBbBCD/////AAAAAQAAAAAAAAAAAAAAAP//////////////
/AQgWsY12Ko6k+ez671VdpiGvGUdBrDMU7D2O848PifSYEsDFQDEnTYIhucEk2pm
eOETnSa3gZ9+kARBBGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC
4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfUCIQD/////AAAAAP//////////
vOb6racXnoTzucrC/GMlUQIBAQNCAAQZElyH/z2K5ZjgxiyoPHsoAIW4s3BWvM3I
63O9HOIgrLsuZbjXaXg3v0uTE5yflrwLGZtMrXZFK+F23M3y7yyRoywwKjAoBgNV
HREEITAfgh1zdHVkaW8uZXhhbXBsZS10YWlsbmV0LnRzLm5ldDAKBggqhkjOPQQD
AgNHADBEAiASgLTfTkLPI1QkN0kzgivNND+wxhtQ0+D7OnmEU0uShAIgcodeQK6W
l67cuZb8ZJb6dQPM/Ol+SsaS4ypVVqzMTn4=
-----END CERTIFICATE-----
`;

const here = (): GatewayLockHolder => ({
  pid: 4242,
  processStart: null,
  hostname: hostname(),
  startedAt: "2026-09-15T00:00:00.000Z",
});
const covered = (): boolean => true;
const TAILNET_HOST = "studio.example-tailnet.ts.net";
/** A certificate naming only the tailnet host, as `omnesis tls provision` mints. */
const tailnetOnly = (_configDir: string, host: string): boolean => host === TAILNET_HOST;
const neverPinned = (host: string): void => {
  throw new Error(`unexpected loopback pin for ${host}`);
};

describe("localGatewayRequestUrl", () => {
  // The address an install records for other machines (omnesis.local, a LAN
  // name) may not resolve on the gateway's own machine: a Linux server has no
  // nss-mdns, and macOS denies Homebrew's node local network access.
  test("a live gateway on this machine is reached over loopback, on the recorded port", () => {
    expect(
      localGatewayRequestUrl("https://omnesis.local:7600", "/cfg", () => here(), covered),
    ).toBe("https://localhost:7600");
    expect(
      localGatewayRequestUrl("https://studio.local:7443/", "/cfg", () => here(), covered),
    ).toBe("https://localhost:7443");
  });

  test("a URL that already names loopback is left alone", () => {
    expect(localGatewayRequestUrl("https://localhost:7600", "/cfg", () => here(), covered)).toBe(
      "https://localhost:7600",
    );
    expect(localGatewayRequestUrl("https://127.0.0.1:7600", "/cfg", () => here(), covered)).toBe(
      "https://127.0.0.1:7600",
    );
  });

  test("with no live gateway holding the config directory, the recorded address is used", () => {
    expect(localGatewayRequestUrl("https://omnesis.local:7600", "/cfg", () => null, covered)).toBe(
      "https://omnesis.local:7600",
    );
  });

  test("a gateway holding the directory from another host is not this machine's", () => {
    const elsewhere = { ...here(), hostname: `${hostname()}-elsewhere` };
    expect(
      localGatewayRequestUrl("https://gateway.example.org:7600", "/cfg", () => elsewhere, covered),
    ).toBe("https://gateway.example.org:7600");
  });

  // A tailnet certificate from `omnesis tls provision`, or an operator's own,
  // names only its host: a localhost URL would fail the certificate check, and
  // the name stops resolving while Tailscale is down. The URL is kept — so the
  // certificate is verified against it — and the name resolves to loopback.
  test("a gateway serving a certificate naming only the recorded host is reached by that name over loopback", () => {
    const pinned: string[] = [];
    expect(
      localGatewayRequestUrl(
        `https://${TAILNET_HOST}:7600`,
        "/cfg",
        () => here(),
        tailnetOnly,
        (host) => pinned.push(host),
      ),
    ).toBe(`https://${TAILNET_HOST}:7600`);
    expect(pinned).toEqual([TAILNET_HOST]);
  });

  test("a certificate naming neither localhost nor the recorded host leaves the address alone", () => {
    expect(
      localGatewayRequestUrl(
        "https://omnesis.local:7600",
        "/cfg",
        () => here(),
        tailnetOnly,
        neverPinned,
      ),
    ).toBe("https://omnesis.local:7600");
  });

  test("the recorded host of a gateway on another machine is never resolved to loopback", () => {
    const elsewhere = { ...here(), hostname: `${hostname()}-elsewhere` };
    expect(
      localGatewayRequestUrl(
        `https://${TAILNET_HOST}:7600`,
        "/cfg",
        () => elsewhere,
        tailnetOnly,
        neverPinned,
      ),
    ).toBe(`https://${TAILNET_HOST}:7600`);
    expect(
      localGatewayRequestUrl(
        `https://${TAILNET_HOST}:7600`,
        "/cfg",
        () => null,
        tailnetOnly,
        neverPinned,
      ),
    ).toBe(`https://${TAILNET_HOST}:7600`);
  });

  test("an address with no explicit port or with a path names a proxy in front of the gateway", () => {
    expect(
      localGatewayRequestUrl("https://omnesis.example.org", "/cfg", () => here(), covered),
    ).toBe("https://omnesis.example.org");
    expect(
      localGatewayRequestUrl(
        "https://omnesis.example.org:8443/omnesis",
        "/cfg",
        () => here(),
        covered,
      ),
    ).toBe("https://omnesis.example.org:8443/omnesis");
  });

  test("an unparseable URL is returned unchanged", () => {
    expect(localGatewayRequestUrl("not a url", "/cfg", () => here(), covered)).toBe("not a url");
  });
});

describe("servedCertificateCoversLocalhost", () => {
  const dirs: string[] = [];
  const configDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-served-cert-"));
    mkdirSync(join(dir, "tls"));
    dirs.push(dir);
    return dir;
  };

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  test("a self-signed certificate not minted yet counts: the gateway mints one naming localhost", () => {
    expect(servedCertificateCoversLocalhost(configDir(), {})).toBe(true);
  });

  test("the self-signed certificate on disk is read", () => {
    const dir = configDir();
    writeFileSync(join(dir, "tls", "cert.pem"), TAILNET_CERT);
    expect(servedCertificateCoversLocalhost(dir, {})).toBe(false);
    writeFileSync(join(dir, "tls", "cert.pem"), LOOPBACK_CERT);
    expect(servedCertificateCoversLocalhost(dir, {})).toBe(true);
  });

  test("OMNESIS_TLS_CERT and OMNESIS_TLS_KEY name the certificate served instead", () => {
    const dir = configDir();
    const cert = join(dir, "tls", "tailscale.crt");
    const env = { OMNESIS_TLS_CERT: cert, OMNESIS_TLS_KEY: join(dir, "tls", "tailscale.key") };
    writeFileSync(cert, TAILNET_CERT);
    expect(servedCertificateCoversLocalhost(dir, env)).toBe(false);
    writeFileSync(cert, LOOPBACK_CERT);
    expect(servedCertificateCoversLocalhost(dir, env)).toBe(true);
  });

  test("a certificate is asked about the recorded host by name", () => {
    const dir = configDir();
    const cert = join(dir, "tls", "tailscale.crt");
    const env = { OMNESIS_TLS_CERT: cert, OMNESIS_TLS_KEY: join(dir, "tls", "tailscale.key") };
    writeFileSync(cert, TAILNET_CERT);
    expect(servedCertificateCoversHost(dir, TAILNET_HOST, env)).toBe(true);
    expect(servedCertificateCoversHost(dir, "other.example-tailnet.ts.net", env)).toBe(false);
    // A self-signed certificate not minted yet names only localhost for sure.
    expect(servedCertificateCoversHost(configDir(), TAILNET_HOST, {})).toBe(false);
  });

  test("a configured certificate that cannot be read does not count", () => {
    const dir = configDir();
    expect(
      servedCertificateCoversLocalhost(dir, {
        OMNESIS_TLS_CERT: join(dir, "missing.crt"),
        OMNESIS_TLS_KEY: join(dir, "missing.key"),
      }),
    ).toBe(false);
  });
});
