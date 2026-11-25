// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createCipheriv, randomBytes } from "node:crypto";
import { constants, lstatSync, linkSync, statSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { PassThrough, Readable, Writable } from "node:stream";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { fsyncDir } from "./atomic-write.js";
import { readInstallRootKey } from "./secret-store.js";
import {
  createWindowsPrivateFile,
  writeWindowsPrivateFileAtomicStream,
} from "./windows-private-file.js";
import {
  MAGIC,
  ALG,
  KDF,
  ENVELOPE_MARKER,
  AppendArtifactEnvelopeTransform,
  headerLengthBytes,
  deriveArtifactKey,
  parseArtifactHeader,
  type EncryptedArtifactHeaderV1,
} from "./artifact-envelope.js";
import type {
  EncryptArtifactFileOptions,
  EncryptArtifactFileResult,
} from "./encrypted-artifact.js";

export interface ProduceEncryptedArtifactOptions extends EncryptArtifactFileOptions {
  /** Memory-only key supplied by an owned worker; never serialized to disk. */
  rootKey?: string;
}

/**
 * Produce an artifact without ever materializing its plaintext in a file.
 * The callback honors stream backpressure and returns without ending the stream.
 * Only complete authenticated ciphertext is published; existing targets are refused.
 */
export async function produceEncryptedArtifact(
  outputPath: string,
  opts: ProduceEncryptedArtifactOptions,
  produce: (body: Writable) => Promise<void>,
): Promise<EncryptArtifactFileResult> {
  const rootKey = opts.rootKey ?? (await readInstallRootKey(opts));
  if (!rootKey) throw new Error("Encrypted artifact production requires the installation key");
  const salt = randomBytes(16),
    iv = randomBytes(12);
  const header: EncryptedArtifactHeaderV1 = {
    omnesis: ENVELOPE_MARKER,
    version: 1,
    alg: ALG,
    kdf: KDF,
    scope: opts.scope,
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  parseArtifactHeader(headerBytes);
  const prefix = Buffer.concat([MAGIC, headerLengthBytes(headerBytes), headerBytes]);
  const key = deriveArtifactKey(rootKey, salt, opts.scope);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(headerBytes);
  const scratchPath = `${outputPath}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  let owned: { dev: bigint; ino: bigint } | undefined;
  let published: { dev: bigint; ino: bigint } | undefined;
  let complete = false;
  try {
    // Windows creates the empty file with a protected DACL before any bytes.
    if (process.platform === "win32") await createWindowsPrivateFile(scratchPath, Buffer.alloc(0));
    const file = await open(scratchPath, process.platform === "win32" ? "r+" : "wx", 0o600);
    try {
      const metadata = await file.stat({ bigint: true });
      const pathMetadata = lstatSync(scratchPath, { bigint: true });
      if (
        !metadata.isFile() ||
        pathMetadata.isSymbolicLink() ||
        metadata.dev !== pathMetadata.dev ||
        metadata.ino !== pathMetadata.ino
      )
        throw new Error("Encrypted artifact staging ownership changed");
      owned = { dev: metadata.dev, ino: metadata.ino };
      const body = new PassThrough();
      let failure: unknown;
      let failed = false;
      const observe = (operation: Promise<void>) =>
        operation.catch((error: unknown) => {
          if (!failed) {
            failed = true;
            failure = error;
          }
          body.destroy();
          throw error;
        });
      const writing = observe(
        pipeline(
          body,
          cipher,
          new AppendArtifactEnvelopeTransform(prefix, () => cipher.getAuthTag()),
          new Writable({
            write(chunk: Buffer, _encoding, callback) {
              void file.writeFile(chunk).then(() => callback(), callback);
            },
          }),
        ),
      );
      const producing = observe(
        Promise.resolve().then(async () => {
          if (failed) throw failure;
          await produce(body);
          body.end();
        }),
      );
      await Promise.allSettled([writing, producing]);
      if (failed) throw failure;
      await file.sync();
    } finally {
      await file.close();
    }
    const ready = lstatSync(scratchPath, { bigint: true });
    if (
      !owned ||
      ready.isSymbolicLink() ||
      !ready.isFile() ||
      ready.dev !== owned.dev ||
      ready.ino !== owned.ino ||
      ready.nlink !== 1n
    )
      throw new Error("Encrypted artifact staging ownership changed");
    if (process.platform === "win32") {
      const source = await open(scratchPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const metadata = await source.stat({ bigint: true });
        if (metadata.dev !== owned.dev || metadata.ino !== owned.ino || metadata.nlink !== 1n)
          throw new Error("Encrypted artifact staging ownership changed");
        async function* chunks() {
          const buffer = Buffer.alloc(64 * 1024);
          for (;;) {
            const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
            if (!bytesRead) return;
            yield Buffer.from(buffer.subarray(0, bytesRead));
          }
        }
        await writeWindowsPrivateFileAtomicStream(
          outputPath,
          Readable.from(chunks()),
          Number(metadata.size),
          { replaceExisting: false },
        );
        const output = lstatSync(outputPath, { bigint: true });
        published = { dev: output.dev, ino: output.ino };
        const after = await source.stat({ bigint: true });
        if (
          metadata.size !== after.size ||
          metadata.mtimeNs !== after.mtimeNs ||
          metadata.ctimeNs !== after.ctimeNs ||
          after.nlink !== 1n
        )
          throw new Error("Encrypted artifact staging ownership changed");
      } finally {
        await source.close();
      }
    } else {
      linkSync(scratchPath, outputPath);
      const output = lstatSync(outputPath, { bigint: true });
      published = { dev: output.dev, ino: output.ino };
      if (
        !output.isFile() ||
        output.isSymbolicLink() ||
        output.dev !== owned.dev ||
        output.ino !== owned.ino ||
        output.nlink !== 2n
      )
        throw new Error("Encrypted artifact publication ownership changed");
    }
    const bytes = statSync(outputPath).size;
    await fsyncDir(dirname(outputPath));
    complete = true;
    return { encrypted: true, path: outputPath, bytes };
  } finally {
    key.fill(0);
    if (!complete && published) {
      try {
        const output = lstatSync(outputPath, { bigint: true });
        if (output.isFile() && output.dev === published.dev && output.ino === published.ino)
          unlinkSync(outputPath);
      } catch {
        /* A replacement destination is never removed. */
      }
    }
    if (owned) {
      try {
        const current = lstatSync(scratchPath, { bigint: true });
        if (current.dev === owned.dev && current.ino === owned.ino && current.isFile())
          unlinkSync(scratchPath);
      } catch {
        /* An absent or replaced scratch file is never adopted. */
      }
    }
  }
}
