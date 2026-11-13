// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createReadStream } from "node:fs";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile } from "@omnesis/core";
import { z } from "zod";
import {
  createRecoveryAuthority,
  signRecoveryReceipt,
  signRecoveryPolicy,
} from "./recovery-authority.js";
import { readPrivateJson } from "./google-credentials.js";
import { recoveryPolicyDigest } from "./recovery-contract.js";
import { assertRecoveryArtifactDestination } from "./recovery-artifact-paths.js";

/** All paths are explicit offline operator inputs; the tool never contacts a relay, Google, DNS or a CA. */
export interface RecoveryAuthorityToolOptions {
  privateKeyFile: string;
  publicKeyFile?: string;
  inputFile?: string;
  outputFile?: string;
  protectedPaths?: readonly string[];
}
async function readSigningKey(path: string): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    if (size > 4096) throw new Error("Recovery signing key file is too large");
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts).toString("utf8");
}
export async function runRecoveryAuthorityTool(
  command: "create" | "receipt" | "policy" | "digest",
  options: RecoveryAuthorityToolOptions,
): Promise<{ policySha256?: string; publicKey?: string }> {
  if (command === "create") {
    const publicFile = z.string().min(1).parse(options.publicKeyFile);
    assertRecoveryArtifactDestination(options.privateKeyFile, [publicFile]);
    const keys = createRecoveryAuthority();
    await mkdir(dirname(options.privateKeyFile), { recursive: true, mode: 0o700 });
    await mkdir(dirname(publicFile), { recursive: true, mode: 0o700 });
    // Exclusive creation never silently replaces an established recovery authority.
    await writeFile(options.privateKeyFile, keys.privateKey, { flag: "wx", mode: 0o600 });
    try {
      await writeFile(publicFile, keys.publicKey, { flag: "wx", mode: 0o600 });
    } catch (error) {
      await unlink(options.privateKeyFile);
      throw error;
    }
    return { publicKey: keys.publicKey };
  }
  const input = await readPrivateJson(z.string().min(1).parse(options.inputFile));
  if (command === "digest") return { policySha256: recoveryPolicyDigest(input) };
  const output = z.string().min(1).parse(options.outputFile);
  const protectedPaths = [
    options.privateKeyFile,
    options.publicKeyFile,
    options.inputFile,
    ...(options.protectedPaths ?? []),
  ];
  assertRecoveryArtifactDestination(output, protectedPaths);
  const key = await readSigningKey(options.privateKeyFile);
  const signed =
    command === "receipt" ? signRecoveryReceipt(input, key) : signRecoveryPolicy(input, key);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const destination = assertRecoveryArtifactDestination(output, protectedPaths);
  await atomicWriteFile(destination, JSON.stringify(signed) + "\n", { mode: 0o600 });
  return command === "policy" ? { policySha256: recoveryPolicyDigest(signed) } : {};
}
