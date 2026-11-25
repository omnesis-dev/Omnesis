// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createDecipheriv, timingSafeEqual, type DecipherGCM } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import {
  MAGIC,
  MAX_ARTIFACT_HEADER_BYTES,
  parseArtifactHeader,
  deriveArtifactKey,
} from "./artifact-envelope.js";

export interface AuthenticatedArtifactRead {
  bytes: number;
  scope: string;
}
export interface ArtifactStreamReadOptions {
  rootKey: string;
  expectedScope?: string;
  signal: AbortSignal;
  maxBytes?: number;
}
/** Plaintext buffers remain unauthenticated until successful EOF; stage only sealed output. */
export interface EncryptedArtifactStream extends AsyncGenerator<Buffer, void, void> {
  authentication(): AuthenticatedArtifactRead;
}

/** Pinned private regular-file reader; never writes a plaintext file. */
export function readEncryptedArtifactStream(
  path: string,
  options: ArtifactStreamReadOptions,
): EncryptedArtifactStream {
  return verifiedStream((authenticated) => readFileArtifact(path, options, authenticated));
}
/** Decode nested artifact streams without materializing any decrypted outer layer on disk. */
export function decryptEncryptedArtifactStream(
  input: AsyncIterable<Uint8Array>,
  options: ArtifactStreamReadOptions,
): EncryptedArtifactStream {
  return verifiedStream((authenticated) => readStreamArtifact(input, options, authenticated));
}
function verifiedStream(
  create: (
    authenticated: (result: AuthenticatedArtifactRead) => void,
  ) => AsyncGenerator<Buffer, void, void>,
): EncryptedArtifactStream {
  let proof: AuthenticatedArtifactRead | undefined;
  return Object.assign(
    create((value) => {
      proof = value;
    }),
    {
      authentication(): AuthenticatedArtifactRead {
        if (!proof) throw new Error("The encrypted artifact has not been authenticated");
        return { ...proof };
      },
    },
  );
}
async function* readFileArtifact(
  path: string,
  options: ArtifactStreamReadOptions,
  authenticated: (result: AuthenticatedArtifactRead) => void,
): AsyncGenerator<Buffer, void, void> {
  let file: FileHandle | undefined;
  try {
    options.signal.throwIfAborted();
    const bound = resourceBound(options.maxBytes);
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
    );
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(bound) ||
      before.size < BigInt(MAGIC.length + 4 + 16) ||
      (before.mode & 0o077n) !== 0n ||
      (process.getuid && before.uid !== BigInt(process.getuid()))
    )
      throw new Error("Invalid artifact input");
    const handle = file;
    const ciphertext = (async function* () {
      let position = 0;
      while (position < Number(before.size)) {
        const block = await exact(
          handle,
          Math.min(64 * 1024, Number(before.size) - position),
          position,
          options.signal,
        );
        position += block.length;
        yield block;
      }
    })();
    const reading = decryptEncryptedArtifactStream(ciphertext, options);
    for await (const block of reading) yield block;
    const proof = reading.authentication();
    const after = await file.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.nlink !== 1n
    )
      throw new Error("Changed artifact input");
    await file.close();
    file = undefined;
    options.signal.throwIfAborted();
    authenticated(proof);
  } catch {
    if (options.signal.aborted) options.signal.throwIfAborted();
    throw new Error("The encrypted artifact could not be authenticated");
  } finally {
    await file?.close();
  }
}
async function* readStreamArtifact(
  input: AsyncIterable<Uint8Array>,
  options: ArtifactStreamReadOptions,
  authenticated: (result: AuthenticatedArtifactRead) => void,
): AsyncGenerator<Buffer, void, void> {
  let key: Buffer | undefined;
  let decipher: DecipherGCM | undefined;
  try {
    const bound = resourceBound(options.maxBytes);
    let buffered = Buffer.alloc(0),
      headerParsed = false,
      scope = "",
      seen = 0,
      bytes = 0;
    for await (const raw of input) {
      options.signal.throwIfAborted();
      if (!(raw instanceof Uint8Array) || raw.byteLength > 1024 * 1024)
        throw new Error("Invalid artifact chunk");
      seen += raw.byteLength;
      if (seen > bound) throw new Error("Artifact resource bound exceeded");
      buffered = Buffer.concat([buffered, raw]);
      if (!headerParsed) {
        if (buffered.length < MAGIC.length + 4) continue;
        if (!timingSafeEqual(buffered.subarray(0, MAGIC.length), MAGIC))
          throw new Error("Unsupported artifact");
        const length = buffered.readUInt32BE(MAGIC.length),
          start = MAGIC.length + 4 + length;
        if (!length || length > MAX_ARTIFACT_HEADER_BYTES)
          throw new Error("Invalid artifact header");
        if (buffered.length < start) continue;
        const headerBytes = buffered.subarray(MAGIC.length + 4, start),
          header = parseArtifactHeader(headerBytes);
        if (options.expectedScope !== undefined && header.scope !== options.expectedScope)
          throw new Error("Invalid artifact scope");
        scope = header.scope;
        key = deriveArtifactKey(options.rootKey, Buffer.from(header.salt, "base64url"), scope);
        decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.iv, "base64url"), {
          authTagLength: 16,
        });
        decipher.setAAD(headerBytes);
        headerParsed = true;
        buffered = buffered.subarray(start);
      }
      if (buffered.length > 16) {
        const plaintext = decipher!.update(buffered.subarray(0, buffered.length - 16));
        buffered = Buffer.from(buffered.subarray(-16));
        bytes += plaintext.length;
        if (plaintext.length) yield plaintext;
      }
    }
    options.signal.throwIfAborted();
    if (!headerParsed || !decipher || buffered.length !== 16) throw new Error("Truncated artifact");
    decipher.setAuthTag(buffered);
    const final = decipher.final();
    bytes += final.length;
    if (final.length) yield final;
    authenticated({ bytes, scope });
  } catch {
    if (options.signal.aborted) options.signal.throwIfAborted();
    throw new Error("The encrypted artifact could not be authenticated");
  } finally {
    key?.fill(0);
    decipher?.destroy();
  }
}
function resourceBound(value = 1024 ** 4): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("Invalid artifact resource bound");
  return value;
}
async function exact(
  file: FileHandle,
  length: number,
  position: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    signal.throwIfAborted();
    const read = await file.read(bytes, offset, length - offset, position + offset);
    if (!read.bytesRead) throw new Error("Truncated artifact input");
    offset += read.bytesRead;
  }
  return bytes;
}
