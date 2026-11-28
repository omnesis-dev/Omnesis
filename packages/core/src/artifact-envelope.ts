// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { hkdfSync } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import { z } from "zod";
import { installRootKeyBytes } from "./secret-store.js";

export const MAGIC = Buffer.from("omnesis.encrypted-artifact.v1\n", "utf8");
export const TAG_BYTES = 16;
export const ALG = "aes-256-gcm";
export const KDF = "hkdf-sha256";
export const ENVELOPE_MARKER = "omnesis.encrypted-artifact";
export const MAX_ARTIFACT_HEADER_BYTES = 8192;
const headerSchema = z
  .object({
    omnesis: z.literal(ENVELOPE_MARKER),
    version: z.literal(1),
    alg: z.literal(ALG),
    kdf: z.literal(KDF),
    scope: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value) <= 4096 && !value.includes("\0")),
    salt: z.string().regex(/^[a-zA-Z0-9_-]{22}$/u),
    iv: z.string().regex(/^[a-zA-Z0-9_-]{16}$/u),
  })
  .strict();
export type EncryptedArtifactHeaderV1 = z.infer<typeof headerSchema>;
export function parseArtifactHeader(headerBytes: Buffer): EncryptedArtifactHeaderV1 {
  if (!headerBytes.length || headerBytes.length > MAX_ARTIFACT_HEADER_BYTES)
    throw new Error("Unsupported encrypted artifact header");
  const header = headerSchema.parse(JSON.parse(headerBytes.toString("utf8")));
  const salt = Buffer.from(header.salt, "base64url"),
    iv = Buffer.from(header.iv, "base64url");
  if (
    salt.length !== 16 ||
    salt.toString("base64url") !== header.salt ||
    iv.length !== 12 ||
    iv.toString("base64url") !== header.iv
  )
    throw new Error("Unsupported encrypted artifact header");
  return header;
}
export function headerLengthBytes(bytes: Buffer): Buffer {
  parseArtifactHeader(bytes);
  const out = Buffer.alloc(4);
  out.writeUInt32BE(bytes.length);
  return out;
}
export function deriveArtifactKey(rootKey: string, salt: Buffer, scope: string): Buffer {
  const root = installRootKeyBytes(rootKey);
  try {
    return Buffer.from(hkdfSync("sha256", root, salt, `omnesis-artifact:${scope}`, 32));
  } finally {
    root.fill(0);
  }
}

export class AppendArtifactEnvelopeTransform extends Transform {
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
