// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Issue a genuinely expired fixture using explicit dates supported across OpenSSL 3.x. */
export function expiredCertificate(options: {
  certificateFile: string;
  privateKeyFile: string;
  outputFile: string;
  issuer?: { certificateFile: string; privateKeyFile: string };
}): void {
  const directory = mkdtempSync(join(tmpdir(), "omnesis-expired-certificate-"));
  const openssl = (...args: string[]) =>
    execFileSync("openssl", args, { cwd: directory, stdio: "pipe" });
  try {
    writeFileSync(join(directory, "index.txt"), "");
    writeFileSync(join(directory, "serial"), "01\n");
    writeFileSync(
      join(directory, "ca.cnf"),
      "[ca]\ndefault_ca = fixture\n[fixture]\ndatabase = index.txt\nserial = serial\nnew_certs_dir = .\ndefault_md = sha256\npolicy = policy\ncopy_extensions = copy\n[policy]\ncommonName = supplied\n",
    );
    openssl(
      "x509",
      "-x509toreq",
      "-in",
      resolve(options.certificateFile),
      "-signkey",
      resolve(options.privateKeyFile),
      "-copy_extensions",
      "copy",
      "-out",
      "leaf.csr",
    );
    const issuer = options.issuer ?? options;
    openssl(
      "ca",
      "-batch",
      "-notext",
      "-config",
      "ca.cnf",
      "-in",
      "leaf.csr",
      "-cert",
      resolve(issuer.certificateFile),
      "-keyfile",
      resolve(issuer.privateKeyFile),
      ...(!options.issuer ? ["-selfsign"] : []),
      "-startdate",
      "20200101000000Z",
      "-enddate",
      "20200102000000Z",
      "-out",
      resolve(options.outputFile),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
