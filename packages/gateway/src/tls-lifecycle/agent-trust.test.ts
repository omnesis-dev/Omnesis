// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import { mkcertRootCandidates, resolveAgentCertificateTrust } from "./agent-trust.js";
import { TlsLifecycleService } from "./service.js";

const scratch = mkdtempSync(join(tmpdir(), "omnesis-agent-trust-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const run = (args: string[]) =>
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });

let counter = 0;

/** A certificate authority, the way `mkcert -install` creates its root. */
function authority(): { certPath: string; keyPath: string } {
  const name = `ca${counter++}`;
  const certPath = join(scratch, `${name}.pem`);
  const keyPath = join(scratch, `${name}.key`);
  run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "30",
    "-subj",
    `/CN=${name}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    keyPath,
    "-out",
    certPath,
  ]);
  return { certPath, keyPath };
}

/** A leaf for localhost issued by `ca`, the way mkcert issues the gateway's certificate. */
function issuedBy(ca: { certPath: string; keyPath: string }): { cert: string; key: string } {
  const name = `leaf${counter++}`;
  const path = (ext: string) => join(scratch, `${name}.${ext}`);
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
  writeFileSync(path("ext"), "basicConstraints = CA:FALSE\nsubjectAltName = DNS:localhost\n");
  run([
    "x509",
    "-req",
    "-in",
    path("csr"),
    "-CA",
    ca.certPath,
    "-CAkey",
    ca.keyPath,
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

/** A self-signed leaf, as the gateway mints its own certificate. */
function selfSigned(): { cert: string; key: string } {
  const name = `self${counter++}`;
  const path = (ext: string) => join(scratch, `${name}.${ext}`);
  run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "30",
    "-subj",
    `/CN=${name}`,
    "-addext",
    "basicConstraints=critical,CA:FALSE",
    "-addext",
    "subjectAltName=DNS:localhost",
    "-keyout",
    path("key"),
    "-out",
    path("crt"),
  ]);
  return { cert: readFileSync(path("crt"), "utf8"), key: readFileSync(path("key"), "utf8") };
}

const root = authority();
const unrelatedRoot = authority();
const mkcertLeaf = issuedBy(root);
const ownLeaf = selfSigned();

describe("mkcertRootCandidates", () => {
  test("puts $CAROOT before mkcert's default directory", () => {
    expect(mkcertRootCandidates({ CAROOT: "/srv/ca" }, "linux", "/home/maya")).toEqual([
      "/srv/ca/rootCA.pem",
      "/home/maya/.local/share/mkcert/rootCA.pem",
    ]);
  });

  test("follows mkcert's per-platform defaults", () => {
    expect(mkcertRootCandidates({ XDG_DATA_HOME: "/data" }, "linux", "/home/maya")).toEqual([
      "/data/mkcert/rootCA.pem",
    ]);
    const darwin = mkcertRootCandidates({}, "darwin", "/Users/maya");
    expect(darwin).toHaveLength(1);
    expect(darwin[0]).toMatch(
      /^\/Users\/maya\/Library\/application support\/mkcert\/rootCA\.pem$/iu,
    );
    expect(mkcertRootCandidates({}, "win32", "/home/maya")).toEqual([]);
  });
});

describe("resolveAgentCertificateTrust", () => {
  test("names the mkcert root that issued the served certificate", () => {
    const certPath = join(scratch, "config", "tls", "mkcert.crt");
    expect(
      resolveAgentCertificateTrust({
        ownership: "mkcert",
        certPath,
        servedCertPem: mkcertLeaf.cert,
        authorityCandidates: [join(scratch, "missing.pem"), unrelatedRoot.certPath, root.certPath],
      }),
    ).toEqual({ kind: "mkcert", trustFile: root.certPath });
  });

  test("names nothing for mkcert when no candidate issued the served certificate", () => {
    expect(
      resolveAgentCertificateTrust({
        ownership: "mkcert",
        certPath: join(scratch, "mkcert.crt"),
        servedCertPem: mkcertLeaf.cert,
        authorityCandidates: [join(scratch, "missing.pem"), unrelatedRoot.certPath],
      }),
    ).toEqual({ kind: "mkcert", trustFile: null });
  });

  test("never offers a leaf as the authority behind itself", () => {
    const leafPath = join(scratch, "leaf-as-ca.pem");
    writeFileSync(leafPath, ownLeaf.cert);
    expect(
      resolveAgentCertificateTrust({
        ownership: "mkcert",
        certPath: leafPath,
        servedCertPem: ownLeaf.cert,
        authorityCandidates: [leafPath],
      }).trustFile,
    ).toBeNull();
  });

  test("names the gateway's own file for its self-signed certificate", () => {
    const certPath = join(scratch, "own.pem");
    writeFileSync(certPath, ownLeaf.cert);
    expect(
      resolveAgentCertificateTrust({
        ownership: "self-signed",
        certPath,
        servedCertPem: ownLeaf.cert,
        authorityCandidates: [],
      }),
    ).toEqual({ kind: "self-signed", trustFile: certPath });
  });

  test("names nothing while the self-signed file on disk is not the served one", () => {
    const certPath = join(scratch, "replaced.pem");
    writeFileSync(certPath, selfSigned().cert);
    expect(
      resolveAgentCertificateTrust({
        ownership: "self-signed",
        certPath,
        servedCertPem: ownLeaf.cert,
        authorityCandidates: [],
      }),
    ).toEqual({ kind: "self-signed", trustFile: null });
  });

  test("names nothing for a Tailscale or an operator's own certificate", () => {
    for (const ownership of ["tailscale", "external"] as const) {
      expect(
        resolveAgentCertificateTrust({
          ownership,
          certPath: root.certPath,
          servedCertPem: mkcertLeaf.cert,
          authorityCandidates: [root.certPath],
        }),
      ).toEqual({ kind: ownership, trustFile: null });
    }
  });
});

describe("TlsLifecycleService.agentCertificateTrust", () => {
  function service(
    configDir: string,
    paths: { certPath?: string; keyPath?: string; caPath?: string },
    roots: string[],
    extra: { initial?: { cert: string; key: string }; inContainer?: boolean } = {},
  ) {
    return new TlsLifecycleService({
      configDir,
      initial: extra.initial ?? mkcertLeaf,
      inContainer: extra.inContainer ?? false,
      activate: () => {},
      materialPaths: () => paths,
      requiredHosts: () => ["localhost"],
      minter: { mint: () => Promise.reject(new Error("not used")) },
      settings: () => ({ autoRenew: false, renewBeforeDays: 30 }),
      mkcertRoots: () => roots,
    });
  }

  function mkcertConfigDir(): { configDir: string; certPath: string; keyPath: string } {
    const configDir = mkdtempSync(join(scratch, "config-"));
    mkdirSync(join(configDir, "tls"));
    const certPath = join(configDir, "tls", "mkcert.crt");
    const keyPath = join(configDir, "tls", "mkcert.key");
    writeFileSync(certPath, mkcertLeaf.cert);
    writeFileSync(keyPath, mkcertLeaf.key);
    return { configDir, certPath, keyPath };
  }

  test("finds the mkcert root in mkcert's directory for this account", () => {
    const { configDir, certPath, keyPath } = mkcertConfigDir();
    expect(
      service(configDir, { certPath, keyPath }, [
        unrelatedRoot.certPath,
        root.certPath,
      ]).agentCertificateTrust(),
    ).toEqual({ kind: "mkcert", trustFile: root.certPath });
  });

  test("prefers the CA the operator recorded, then a copy beside the material", () => {
    const { configDir, certPath, keyPath } = mkcertConfigDir();
    const copy = join(configDir, "tls", "rootCA.pem");
    writeFileSync(copy, readFileSync(root.certPath, "utf8"));
    expect(
      service(configDir, { certPath, keyPath }, [root.certPath]).agentCertificateTrust(),
    ).toEqual({ kind: "mkcert", trustFile: copy });
    expect(
      service(configDir, { certPath, keyPath, caPath: root.certPath }, []).agentCertificateTrust(),
    ).toEqual({ kind: "mkcert", trustFile: root.certPath });
  });

  test("names nothing when the mkcert root cannot be found", () => {
    const { configDir, certPath, keyPath } = mkcertConfigDir();
    expect(
      service(configDir, { certPath, keyPath }, [
        join(scratch, "nowhere", "rootCA.pem"),
      ]).agentCertificateTrust(),
    ).toEqual({ kind: "mkcert", trustFile: null });
  });

  test("skips the account's mkcert directory inside a container", () => {
    const { configDir, certPath, keyPath } = mkcertConfigDir();
    expect(
      service(configDir, { certPath, keyPath }, [root.certPath], {
        inContainer: true,
      }).agentCertificateTrust(),
    ).toEqual({ kind: "mkcert", trustFile: null });
    const copy = join(configDir, "tls", "rootCA.pem");
    writeFileSync(copy, readFileSync(root.certPath, "utf8"));
    expect(
      service(configDir, { certPath, keyPath }, [], { inContainer: true }).agentCertificateTrust(),
    ).toEqual({ kind: "mkcert", trustFile: copy });
  });

  test("follows the gateway's own certificate file as it is replaced on disk", () => {
    const configDir = mkdtempSync(join(scratch, "config-"));
    mkdirSync(join(configDir, "tls"));
    const certPath = join(configDir, "tls", "cert.pem");
    writeFileSync(certPath, ownLeaf.cert);
    const lifecycle = service(configDir, {}, [], { initial: ownLeaf });
    expect(lifecycle.agentCertificateTrust()).toEqual({ kind: "self-signed", trustFile: certPath });
    // A file that no longer matches what is served is never offered.
    writeFileSync(certPath, selfSigned().cert);
    expect(lifecycle.agentCertificateTrust()).toEqual({ kind: "self-signed", trustFile: null });
  });
});
