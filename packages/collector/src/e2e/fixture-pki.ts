// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A throwaway certificate authority for end-to-end suites: one CA and leaves
 * for the names a suite serves, made with the system's openssl.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  runFixtureOpenSsl,
  type FixtureOpenSslOptions,
} from "../../../../scripts/desktop/fixture-openssl.mjs";

/** The embedded SCT list extension a publicly logged leaf carries (RFC 6962 §3.3). */
export const SCT_EXTENSION_LINE = "1.3.6.1.4.1.11129.2.4.2=ASN1:FORMAT:HEX,OCTETSTRING:00000000";

export interface Leaf {
  certFile: string;
  keyFile: string;
  cert: string;
}

export interface TestPki {
  caCertFile: string;
  caCert: string;
  /** A leaf from this authority. `sct` adds the embedded SCT extension. */
  leaf(name: string, hosts: readonly string[], options?: { sct?: boolean }): Promise<Leaf>;
}

export async function createTestPki(
  directory: string,
  label: string,
  execution: FixtureOpenSslOptions = {},
): Promise<TestPki> {
  await mkdir(directory, { recursive: true });
  const caKeyFile = join(directory, `${label}-ca.key`),
    caCertFile = join(directory, `${label}-ca.pem`);
  await runFixtureOpenSsl(
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKeyFile,
      "-out",
      caCertFile,
      "-days",
      "2",
      "-subj",
      `/CN=Fictional ${label} authority`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    execution,
  );
  let serial = 0;
  return {
    caCertFile,
    caCert: await readFile(caCertFile, "utf8"),
    async leaf(name, hosts, options = {}) {
      const base = join(directory, `${label}-${name}-${++serial}`);
      const keyFile = `${base}.key`,
        certFile = `${base}.pem`,
        requestFile = `${base}.csr`,
        extensionsFile = `${base}.ext`;
      await runFixtureOpenSsl(
        [
          "req",
          "-new",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-nodes",
          "-keyout",
          keyFile,
          "-out",
          requestFile,
          "-subj",
          `/CN=${hosts[0]}`,
        ],
        execution,
      );
      const names = hosts
        .map((host) => (/^[0-9.]+$/.test(host) ? `IP:${host}` : `DNS:${host}`))
        .join(",");
      await writeFile(
        extensionsFile,
        [
          `subjectAltName=${names}`,
          "basicConstraints=critical,CA:FALSE",
          "keyUsage=critical,digitalSignature",
          "extendedKeyUsage=serverAuth",
          ...(options.sct ? [SCT_EXTENSION_LINE] : []),
          "",
        ].join("\n"),
      );
      await runFixtureOpenSsl(
        [
          "x509",
          "-req",
          "-in",
          requestFile,
          "-CA",
          caCertFile,
          "-CAkey",
          caKeyFile,
          "-set_serial",
          `0x${randomBytes(8).toString("hex")}`,
          "-out",
          certFile,
          "-days",
          "1",
          "-extfile",
          extensionsFile,
        ],
        execution,
      );
      if (process.platform === "win32") {
        const { ensurePrivateFileSync } = await import("@omnesis/core");
        ensurePrivateFileSync(keyFile);
      } else {
        await chmod(keyFile, 0o600);
      }
      return { certFile, keyFile, cert: await readFile(certFile, "utf8") };
    },
  };
}
