// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The trust decision over real handshakes. A private root stands in for the
 * public CA set, so a "renewal" is a second leaf from the same root, and the
 * attacks are certificates a network adversary could actually present.
 */

import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connect as tlsConnect,
  createServer,
  getCACertificates,
  type DetailedPeerCertificate,
  type Server,
} from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { PinnedGatewayHttpClient } from "./http.js";
import { certificateCannotIssue } from "./certificate-authority.js";
import { GatewayTlsError, type TlsTrust } from "./tls.js";
import { anchoredByPin, GatewayTrust, publicRoots } from "./trust.js";

const NAME = "gateway.example.test";

interface Minted {
  certPem: string;
  keyPem: string;
  fingerprint: string;
}

let directory: string;
let root: Minted;
let current: Minted;
let renewed: Minted;
let bareLeaf: Minted;
let impostor: Minted;
let caPin: Minted;
let signOnly: Minted;
let signOnlyImpostor: Minted;
let v1: Minted;
let v1Impostor: Minted;
let unrelated: Minted;

function openssl(args: string[]): void {
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
}

function read(name: string): Minted {
  const certPem = readFileSync(join(directory, `${name}.pem`), "utf8");
  return {
    certPem,
    keyPem: readFileSync(join(directory, `${name}.key`), "utf8"),
    fingerprint: new X509Certificate(certPem).fingerprint256.replaceAll(":", "").toLowerCase(),
  };
}

type Profile = "ca" | "leaf" | "bare-leaf" | "sign-only";

/**
 * `bare-leaf` is CA:FALSE with no key usage at all, so only basic constraints
 * stand between it and issuing a certificate. `sign-only` has no basic
 * constraints but may sign certificates, which OpenSSL accepts as an issuer.
 */
function extensions(name: string, profile: Profile): string {
  const path = join(directory, `${name}.ext`);
  const san = `subjectAltName = DNS:${NAME}, IP:127.0.0.1\n`;
  writeFileSync(
    path,
    profile === "ca"
      ? "basicConstraints = critical, CA:TRUE\nkeyUsage = critical, keyCertSign, cRLSign, digitalSignature\n" +
          san
      : profile === "leaf"
        ? "basicConstraints = critical, CA:FALSE\nkeyUsage = critical, digitalSignature, keyEncipherment\n" +
          `extendedKeyUsage = serverAuth\n${san}`
        : profile === "sign-only"
          ? `keyUsage = digitalSignature, keyCertSign\n${san}`
          : `basicConstraints = critical, CA:FALSE\n${san}`,
  );
  return path;
}

/** A self-signed certificate; `ca` decides whether it may issue others. */
function selfSigned(name: string, profile: Profile): Minted {
  openssl([
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "3",
    "-subj",
    `/CN=${name}`,
    "-keyout",
    join(directory, `${name}.key`),
    "-out",
    join(directory, `${name}.pem`),
    "-extensions",
    "v3",
    "-config",
    configFor(name, profile),
  ]);
  return read(name);
}

function configFor(name: string, profile: Profile): string {
  const path = join(directory, `${name}.cnf`);
  writeFileSync(
    path,
    `[req]\ndistinguished_name = dn\n[dn]\n[v3]\n${readFileSync(extensions(name, profile), "utf8")}`,
  );
  return path;
}

/** A version 1 self-signed certificate: no extensions, and an issuer to OpenSSL. */
function versionOne(name: string): Minted {
  openssl([
    "req",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-subj",
    `/CN=${NAME}`,
    "-keyout",
    join(directory, `${name}.key`),
    "-out",
    join(directory, `${name}.csr`),
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    join(directory, `${name}.csr`),
    "-signkey",
    join(directory, `${name}.key`),
    "-days",
    "3",
    "-out",
    join(directory, `${name}.pem`),
  ]);
  return read(name);
}

/** A server leaf for {@link NAME}, issued by `issuer` — which need not be a CA. */
function issuedBy(name: string, issuer: string, profile: Profile = "leaf"): Minted {
  openssl([
    "req",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-subj",
    `/CN=${name}`,
    "-keyout",
    join(directory, `${name}.key`),
    "-out",
    join(directory, `${name}.csr`),
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    join(directory, `${name}.csr`),
    "-CA",
    join(directory, `${issuer}.pem`),
    "-CAkey",
    join(directory, `${issuer}.key`),
    "-CAcreateserial",
    "-days",
    "3",
    "-extfile",
    extensions(name, profile),
    "-out",
    join(directory, `${name}.pem`),
  ]);
  return read(name);
}

const servers: Server[] = [];

async function serve(leaf: Minted, chain: Minted[] = []): Promise<number> {
  const server = createServer(
    { key: leaf.keyPem, cert: [leaf.certPem, ...chain.map((c) => c.certPem)].join("") },
    (socket) => socket.end(),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fictional gateway did not listen");
  return address.port;
}

function pinOf(minted: Minted): TlsTrust {
  return { caPem: minted.certPem, leafFingerprintSha256: minted.fingerprint };
}

function trustFor(
  port: number,
  trust: TlsTrust,
  options: { host?: string; onUpgraded?: () => void } = {},
): GatewayTrust {
  return new GatewayTrust({
    gatewayUrl: `https://${options.host ?? NAME}:${port}`,
    trust,
    harness: "openclaw",
    systemRoots: () => [root.certPem],
    ...(options.onUpgraded ? { onUpgraded: options.onUpgraded } : {}),
  });
}

/** One handshake to the local server, presenting `host` as the gateway's name. */
function handshake(trust: GatewayTrust, port: number, host = NAME): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      {
        ...trust.connectionOptions(),
        host: "127.0.0.1",
        port,
        ...(host === "127.0.0.1" ? {} : { servername: host }),
      },
      () => {
        socket.end();
        resolve();
      },
    );
    socket.once("error", (error) => reject(trust.classify(error)));
  });
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "omnesis-gateway-trust-"));
  root = selfSigned("fictional-root", "ca");
  current = issuedBy("current-leaf", "fictional-root");
  renewed = issuedBy("renewed-leaf", "fictional-root");
  bareLeaf = issuedBy("bare-leaf", "fictional-root", "bare-leaf");
  // Signed with a pinned leaf's own key: what an adversary holding a copy of
  // that key — but no CA — could present. The pinned leaf carries no key
  // usage, so only its CA:FALSE constraint can refuse the issuance.
  impostor = issuedBy("impostor-leaf", "bare-leaf");
  caPin = selfSigned("self-signed-ca-gateway", "ca");
  // Neither is CA:TRUE, yet OpenSSL accepts both as issuers.
  signOnly = selfSigned("sign-only-gateway", "sign-only");
  signOnlyImpostor = issuedBy("sign-only-impostor", "sign-only-gateway");
  v1 = versionOne("v1-gateway");
  v1Impostor = issuedBy("v1-impostor", "v1-gateway");
  unrelated = selfSigned("unrelated-gateway", "leaf");
});

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("GatewayTrust over real TLS", () => {
  test("accepts the pinned leaf and stays pinned", async () => {
    const port = await serve(current);
    const onUpgraded = vi.fn();
    const trust = trustFor(port, pinOf(current), { onUpgraded });
    await handshake(trust, port);
    expect(onUpgraded).not.toHaveBeenCalled();
    expect(trust.mode()).toBe("pinned-leaf");
    // A pin on a public name gives way to public trust at a renewal, and
    // says so, so the gateway does not warn about the renewal it follows.
    expect(trust.helloCapability()).toEqual({ mode: "pinned-leaf", followsPublicRenewal: true });
  });

  test("follows a renewal from a public root once, and moves to system trust", async () => {
    const port = await serve(renewed);
    const onUpgraded = vi.fn();
    const trust = trustFor(port, pinOf(current), { onUpgraded });
    const pinnedPool = trust.agent();
    await handshake(trust, port);
    await handshake(trust, port);
    expect(onUpgraded).toHaveBeenCalledTimes(1);
    expect(onUpgraded).toHaveBeenCalledWith(current.fingerprint);
    // Requests made from here on never reuse a socket set up under the pin.
    expect(trust.agent()).not.toBe(pinnedPool);
    expect(trust.mode()).toBe("system");
    expect(trust.helloCapability()).toEqual({ mode: "system" });
  });

  test("stays strictly pinned for a gateway addressed by IP", async () => {
    const port = await serve(renewed);
    const onUpgraded = vi.fn();
    const trust = trustFor(port, pinOf(current), { host: "127.0.0.1", onUpgraded });
    await expect(handshake(trust, port, "127.0.0.1")).rejects.toBeInstanceOf(GatewayTlsError);
    expect(onUpgraded).not.toHaveBeenCalled();
    expect(trust.mode()).toBe("pinned-leaf");
    expect(trust.helloCapability()).toEqual({ mode: "pinned-leaf" });
  });

  test("refuses a certificate signed by the pinned leaf rather than a CA", async () => {
    const port = await serve(impostor, [bareLeaf]);
    const onUpgraded = vi.fn();
    const trust = trustFor(port, pinOf(bareLeaf), { onUpgraded });
    const failure = await handshake(trust, port).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GatewayTlsError);
    // OpenSSL refuses a CA:FALSE issuer by its constraint or by its purpose.
    expect(["INVALID_CA", "INVALID_PURPOSE"]).toContain((failure as GatewayTlsError).code);
    expect(onUpgraded).not.toHaveBeenCalled();
    expect(trust.mode()).toBe("pinned-leaf");
  });

  test("keeps a pinned CA certificate strict even when the served chain is public", async () => {
    const port = await serve(renewed);
    const onUpgraded = vi.fn();
    const trust = trustFor(port, pinOf(caPin), { onUpgraded });
    await expect(handshake(trust, port)).rejects.toBeInstanceOf(GatewayTlsError);
    expect(onUpgraded).not.toHaveBeenCalled();
  });

  test("names the repair command when the gateway serves an unrelated self-signed certificate", async () => {
    const port = await serve(unrelated);
    const trust = trustFor(port, pinOf(current));
    const failure = await handshake(trust, port).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GatewayTlsError);
    expect((failure as GatewayTlsError).code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    expect((failure as Error).message).toContain("omnesis connect openclaw --refresh");
    expect((failure as Error).message).toContain("--trust-fingerprint sha256:");
  });

  test("system trust verifies the name and the public chain", async () => {
    const good = await serve(renewed);
    await handshake(trustFor(good, { mode: "system" }), good);
    const bad = await serve(unrelated);
    await expect(handshake(trustFor(bad, { mode: "system" }), bad)).rejects.toBeInstanceOf(
      GatewayTlsError,
    );
    await expect(
      handshake(trustFor(good, { mode: "system" }), good, "other.example.test"),
    ).rejects.toBeInstanceOf(GatewayTlsError);
  });

  test("an HTTP client reports a refused certificate as a GatewayTlsError", async () => {
    const port = await serve(unrelated);
    const gatewayUrl = `https://127.0.0.1:${port}`;
    const client = new PinnedGatewayHttpClient(
      gatewayUrl,
      "",
      new GatewayTrust({ gatewayUrl, trust: pinOf(current), harness: "openclaw" }),
    );
    await expect(client.requestJson("GET", "/health")).rejects.toBeInstanceOf(GatewayTlsError);
  });

  test.each([
    ["a version 1 self-signed pin", () => [v1, v1Impostor] as const],
    [
      "a pin that may sign certificates but has no basic constraints",
      () => [signOnly, signOnlyImpostor] as const,
    ],
  ])("stays strict for %s, and refuses what it signed", async (_label, pick) => {
    const [pin, impostorLeaf] = pick();
    const port = await serve(impostorLeaf, [pin]);
    const onUpgraded = vi.fn();
    const trust = trustFor(port, pinOf(pin), { onUpgraded });
    expect(trust.mode()).toBe("pinned-ca");
    await expect(handshake(trust, port)).rejects.toBeInstanceOf(GatewayTlsError);
    expect(onUpgraded).not.toHaveBeenCalled();
    expect(trust.mode()).toBe("pinned-ca");
    expect(trust.helloCapability()).toEqual({ mode: "pinned-ca" });
  });
});

describe("whether a pin can issue", () => {
  test("only an explicit CA:FALSE rules it out", () => {
    const der = (minted: Minted) => new X509Certificate(minted.certPem).raw;
    expect(certificateCannotIssue(der(current))).toBe(true);
    expect(certificateCannotIssue(der(bareLeaf))).toBe(true);
    expect(certificateCannotIssue(der(root))).toBe(false);
    expect(certificateCannotIssue(der(caPin))).toBe(false);
    expect(certificateCannotIssue(der(signOnly))).toBe(false);
    expect(certificateCannotIssue(der(v1))).toBe(false);
    expect(certificateCannotIssue(Buffer.from("not a certificate"))).toBe(false);
  });
});

describe("a chain issued under the pin", () => {
  /** The detailed peer certificate Node hands `checkServerIdentity`. */
  function chain(...links: Minted[]): DetailedPeerCertificate {
    const certs = links.map(
      (link) => ({ raw: new X509Certificate(link.certPem).raw }) as DetailedPeerCertificate,
    );
    certs.forEach((cert, i) => {
      cert.issuerCertificate = certs[i + 1] ?? cert;
    });
    return certs[0]!;
  }

  test("is recognised by the pin's signature or the pin standing as an issuer", () => {
    expect(anchoredByPin(chain(signOnlyImpostor), signOnly.certPem, signOnly.fingerprint)).toBe(
      true,
    );
    expect(
      anchoredByPin(chain(signOnlyImpostor, signOnly), signOnly.certPem, signOnly.fingerprint),
    ).toBe(true);
    expect(anchoredByPin(chain(renewed, root), current.certPem, current.fingerprint)).toBe(false);
  });
});

describe("the public roots system trust verifies against", () => {
  test("are Node's bundled roots without the distrusted emSign roots", () => {
    const emSign = /CN=emSign (ECC )?Root CA - (G3|C1|C3)$/mu;
    const roots = publicRoots();
    expect(roots.some((pem) => emSign.test(new X509Certificate(pem).subject))).toBe(false);
    expect(roots).toEqual(
      getCACertificates("bundled").filter((pem) => !emSign.test(new X509Certificate(pem).subject)),
    );
  });
});

describe("the public roots, where Node still bundles the emSign roots", () => {
  // Node 24.22.1 and 26.12.1 bundle none of them, so the test above passes
  // there whatever the filter does; core's fixture of the roots keeps this one
  // meaningful on any Node.
  const emSignRoots =
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../core/src/testdata/emsign-roots.pem"),
      "utf8",
    ).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu) ?? [];

  test("leave out exactly the emSign roots", () => {
    expect(emSignRoots).toHaveLength(3);
    const bundled = getCACertificates("bundled");
    expect(publicRoots([...bundled, ...emSignRoots])).toEqual(publicRoots(bundled));
    expect(publicRoots(emSignRoots)).toEqual([]);
  });
});
