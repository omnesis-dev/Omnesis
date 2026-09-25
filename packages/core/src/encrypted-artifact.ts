// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Root-key-wrapped exported artifacts.
 *
 * Secret files use a JSON envelope because they are tiny text values. Backups
 * and exports can be multi-GB database snapshots, so this helper uses a small
 * authenticated binary envelope and streams ciphertext to disk.
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  closeSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open, readFile } from "node:fs/promises";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  installRootKeyBytes,
  readInstallRootKey,
  type CreateSecretStoreOptions,
} from "./secret-store.js";
import { secretFileEncryptionRequired } from "./secret-file.js";
import { ensurePrivateFileSync } from "./security-files.js";

const MAGIC = Buffer.from("omnesis.encrypted-artifact.v1\n", "utf8");
const TAG_BYTES = 16;
const ALG = "aes-256-gcm";
const KDF = "hkdf-sha256";
const ENVELOPE_MARKER = "omnesis.encrypted-artifact";

export const ENCRYPTED_ARTIFACT_SUFFIX = ".enc";

interface EncryptedArtifactHeaderV1 {
  omnesis: typeof ENVELOPE_MARKER;
  version: 1;
  alg: typeof ALG;
  kdf: typeof KDF;
  scope: string;
  salt: string;
  iv: string;
}

export interface EncryptArtifactFileOptions extends CreateSecretStoreOptions {
  /** Stable logical scope for associated data and key derivation. */
  scope: string;
}

export interface EncryptArtifactFileResult {
  encrypted: boolean;
  /** Final path. Equal to the input path when no root key is available. */
  path: string;
  bytes: number;
}

export interface DecryptArtifactFileToFileOptions extends CreateSecretStoreOptions {
  force?: boolean;
}

export interface DecryptArtifactFileToFileResult {
  decrypted: boolean;
  path: string;
  bytes: number;
}

class AppendArtifactEnvelopeTransform extends Transform {
  private headerWritten = false;

  constructor(
    private readonly prefix: Buffer,
    private readonly getAuthTag: () => Buffer,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (!this.headerWritten) {
      this.push(this.prefix);
      this.headerWritten = true;
    }
    this.push(chunk);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (!this.headerWritten) {
        this.push(this.prefix);
        this.headerWritten = true;
      }
      this.push(this.getAuthTag());
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export async function encryptArtifactFileInPlace(
  path: string,
  opts: EncryptArtifactFileOptions,
): Promise<EncryptArtifactFileResult> {
  const rootKey = await readInstallRootKey(opts);
  if (!rootKey) {
    if (secretFileEncryptionRequired(opts.configDir)) {
      throw new Error(
        `Refusing to write Omnesis encrypted artifact without the install root key after keyring-backed secret files were enabled: ${path}. Unlock the OS keyring or restore the Omnesis install root key first.`,
      );
    }
    return { encrypted: false, path, bytes: statSync(path).size };
  }

  const outputPath = `${path}${ENCRYPTED_ARTIFACT_SUFFIX}`;
  const tmpPath = `${outputPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
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
  const prefix = Buffer.concat([MAGIC, headerLengthBytes(headerBytes), headerBytes]);
  const key = deriveArtifactKey(rootKey, salt, opts.scope);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(headerBytes);

  try {
    await pipeline(
      createReadStream(path),
      cipher,
      new AppendArtifactEnvelopeTransform(prefix, () => cipher.getAuthTag()),
      createWriteStream(tmpPath, { mode: 0o600 }),
    );
    ensurePrivateFileSync(tmpPath);
    try {
      unlinkSync(outputPath);
    } catch {
      /* no prior encrypted output */
    }
    renameSync(tmpPath, outputPath);
    ensurePrivateFileSync(outputPath);
    unlinkSync(path);
    return { encrypted: true, path: outputPath, bytes: statSync(outputPath).size };
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  } finally {
    key.fill(0);
  }
}

export function isEncryptedArtifactBuffer(buffer: Buffer): boolean {
  return buffer.length >= MAGIC.length && timingSafeEqual(buffer.subarray(0, MAGIC.length), MAGIC);
}

export function isEncryptedArtifactFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const fd = openSync(path, "r");
  try {
    const prefix = Buffer.alloc(MAGIC.length);
    const bytes = readSync(fd, prefix, 0, MAGIC.length, 0);
    return bytes === MAGIC.length && timingSafeEqual(prefix, MAGIC);
  } finally {
    closeSync(fd);
  }
}

export async function decryptArtifactFileToBuffer(
  path: string,
  opts: CreateSecretStoreOptions = {},
): Promise<Buffer> {
  const raw = await readFile(path);
  if (!isEncryptedArtifactBuffer(raw)) return raw;
  const rootKey = await readInstallRootKey(opts);
  if (!rootKey) throw new Error(`Cannot decrypt encrypted artifact ${path}: root key unavailable`);

  const { header, headerBytes, ciphertext, tag } = parseArtifactEnvelope(raw);
  const key = deriveArtifactKey(rootKey, Buffer.from(header.salt, "base64url"), header.scope);
  try {
    const decipher = createDecipheriv(ALG, key, Buffer.from(header.iv, "base64url"), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(headerBytes);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } finally {
    key.fill(0);
  }
}

export async function decryptArtifactFileToFile(
  inputPath: string,
  outputPath: string,
  opts: DecryptArtifactFileToFileOptions = {},
): Promise<DecryptArtifactFileToFileResult> {
  const envelope = await parseArtifactEnvelopeFromFile(inputPath);
  const rootKey = await readInstallRootKey(opts);
  if (!rootKey)
    throw new Error(`Cannot decrypt encrypted artifact ${inputPath}: root key unavailable`);
  if (existsSync(outputPath) && !opts.force) {
    throw new Error(`Refusing to overwrite existing file: ${outputPath}`);
  }
  if (inputPath === outputPath) {
    throw new Error("Encrypted artifact output path must differ from the input path");
  }

  const tmpPath = `${outputPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const key = deriveArtifactKey(
    rootKey,
    Buffer.from(envelope.header.salt, "base64url"),
    envelope.header.scope,
  );
  const decipher = createDecipheriv(ALG, key, Buffer.from(envelope.header.iv, "base64url"), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(envelope.headerBytes);
  decipher.setAuthTag(envelope.tag);

  try {
    if (envelope.ciphertextEndInclusive >= envelope.ciphertextStart) {
      await pipeline(
        createReadStream(inputPath, {
          start: envelope.ciphertextStart,
          end: envelope.ciphertextEndInclusive,
        }),
        decipher,
        createWriteStream(tmpPath, { mode: 0o600 }),
      );
    } else {
      writeFileSync(tmpPath, decipher.final(), { mode: 0o600 });
    }
    ensurePrivateFileSync(tmpPath);
    renameSync(tmpPath, outputPath);
    ensurePrivateFileSync(outputPath);
    return { decrypted: true, path: outputPath, bytes: statSync(outputPath).size };
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  } finally {
    key.fill(0);
  }
}

function parseArtifactEnvelope(raw: Buffer): {
  header: EncryptedArtifactHeaderV1;
  headerBytes: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
} {
  if (!isEncryptedArtifactBuffer(raw)) throw new Error("Not an Omnesis encrypted artifact");
  const headerLengthOffset = MAGIC.length;
  const headerLength = raw.readUInt32BE(headerLengthOffset);
  const headerStart = headerLengthOffset + 4;
  const headerEnd = headerStart + headerLength;
  if (headerEnd + TAG_BYTES > raw.length) {
    throw new Error("Encrypted artifact envelope is truncated");
  }
  const headerBytes = raw.subarray(headerStart, headerEnd);
  const parsed = parseArtifactHeader(headerBytes);
  return {
    header: parsed,
    headerBytes,
    ciphertext: raw.subarray(headerEnd, raw.length - TAG_BYTES),
    tag: raw.subarray(raw.length - TAG_BYTES),
  };
}

async function parseArtifactEnvelopeFromFile(path: string): Promise<{
  header: EncryptedArtifactHeaderV1;
  headerBytes: Buffer;
  ciphertextStart: number;
  ciphertextEndInclusive: number;
  tag: Buffer;
}> {
  const handle = await open(path, "r");
  try {
    const st = await handle.stat();
    if (st.size < MAGIC.length + 4 + TAG_BYTES) {
      throw new Error("Encrypted artifact envelope is truncated");
    }
    const magic = Buffer.alloc(MAGIC.length);
    await readExact(handle, magic, 0);
    if (!timingSafeEqual(magic, MAGIC)) throw new Error("Not an Omnesis encrypted artifact");

    const headerLen = Buffer.alloc(4);
    await readExact(handle, headerLen, MAGIC.length);
    const headerLength = headerLen.readUInt32BE(0);
    const headerStart = MAGIC.length + 4;
    const headerEnd = headerStart + headerLength;
    if (headerEnd + TAG_BYTES > st.size) {
      throw new Error("Encrypted artifact envelope is truncated");
    }

    const headerBytes = Buffer.alloc(headerLength);
    await readExact(handle, headerBytes, headerStart);
    const tag = Buffer.alloc(TAG_BYTES);
    await readExact(handle, tag, st.size - TAG_BYTES);
    return {
      header: parseArtifactHeader(headerBytes),
      headerBytes,
      ciphertextStart: headerEnd,
      ciphertextEndInclusive: st.size - TAG_BYTES - 1,
      tag,
    };
  } finally {
    await handle.close();
  }
}

async function readExact(
  handle: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesRead === 0) throw new Error("Encrypted artifact envelope is truncated");
    offset += bytesRead;
  }
}

function parseArtifactHeader(headerBytes: Buffer): EncryptedArtifactHeaderV1 {
  const parsed = JSON.parse(headerBytes.toString("utf8")) as Partial<EncryptedArtifactHeaderV1>;
  if (
    parsed.omnesis !== ENVELOPE_MARKER ||
    parsed.version !== 1 ||
    parsed.alg !== ALG ||
    parsed.kdf !== KDF ||
    typeof parsed.scope !== "string" ||
    typeof parsed.salt !== "string" ||
    typeof parsed.iv !== "string"
  ) {
    throw new Error("Encrypted artifact envelope has an unsupported header");
  }
  return parsed as EncryptedArtifactHeaderV1;
}

function headerLengthBytes(headerBytes: Buffer): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(headerBytes.length);
  return out;
}

function deriveArtifactKey(rootKey: string, salt: Buffer, scope: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", installRootKeyBytes(rootKey), salt, `omnesis-artifact:${scope}`, 32),
  );
}
