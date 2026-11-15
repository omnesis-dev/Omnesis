// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
const nonceSchema = z.string().regex(/^[a-f0-9]{64}$/);
const literal = z
  .string()
  .max(32767)
  .refine((value) => !value.includes("\0"));
export const e2eInputSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("launch"),
      version: z.literal(1),
      nonce: nonceSchema,
      command: literal.refine((value) => value.length > 0),
      args: z.array(literal).max(1024),
    })
    .strict(),
  z.object({ type: z.literal("shutdown"), version: z.literal(1), nonce: nonceSchema }).strict(),
]);
const controlSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("spawned"), pid: z.number().int().positive().max(0x7fffffff) })
    .strict(),
  z.object({ type: z.literal("shutdown-ack"), accepted: z.boolean() }).strict(),
  z
    .object({
      type: z.literal("closed"),
      code: z.number().int().nullable(),
      signal: z
        .string()
        .regex(/^SIG[A-Z0-9]{1,16}$/)
        .nullable(),
    })
    .strict()
    .refine(
      (frame) =>
        (frame.code !== null || frame.signal !== null) &&
        (frame.code === null || frame.signal === null),
    ),
  z
    .object({ type: z.literal("failed"), code: z.enum(["spawn", "protocol", "control", "output"]) })
    .strict(),
]);
export type E2EInput = z.infer<typeof e2eInputSchema>;
export type E2EControl = z.infer<typeof controlSchema>;
const MAX_INPUT = 262144,
  MAX_CONTROL = 4096;
export function encodeE2EInput(frame: E2EInput): Buffer {
  const valid = e2eInputSchema.safeParse(frame);
  if (!valid.success) throw Error("Invalid E2E input frame");
  const bytes = Buffer.from(JSON.stringify(valid.data));
  if (bytes.length > MAX_INPUT) throw Error("E2E input frame exceeds its limit");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}
export class E2EInputDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  constructor(private readonly receive: (frame: E2EInput) => void) {}
  write(bytes: Uint8Array): void {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE();
      if (size > MAX_INPUT) throw Error("E2E input frame exceeds its limit");
      if (this.buffer.length < 4 + size) return;
      let value: unknown;
      try {
        value = JSON.parse(this.buffer.subarray(4, 4 + size).toString());
      } catch {
        throw Error("Invalid E2E input frame");
      }
      const parsed = e2eInputSchema.safeParse(value);
      if (!parsed.success) throw Error("Invalid E2E input frame");
      this.buffer = this.buffer.subarray(4 + size);
      this.receive(parsed.data);
    }
  }
  end(): void {
    if (this.buffer.length) throw Error("Truncated E2E input frame");
  }
}
const CONTROL_MARKER = Buffer.from("\0OMNESIS_E2E_CONTROL_V1\0", "ascii");
const AUTH_BYTES = 32;
function key(nonce: string): Buffer {
  if (!nonceSchema.safeParse(nonce).success) throw Error("Invalid E2E control identity");
  return Buffer.from(nonce, "hex");
}
function authentication(
  secret: Buffer,
  kind: "header" | "payload",
  size: Buffer,
  payload?: Buffer,
): Buffer {
  const hmac = createHmac("sha256", secret)
    .update("OMNESIS_E2E_CONTROL_V1:" + kind + "\0")
    .update(size);
  if (payload) hmac.update(payload);
  return hmac.digest();
}
export function encodeE2EControl(nonce: string, frame: E2EControl): Buffer {
  const secret = key(nonce),
    parsed = controlSchema.safeParse(frame);
  if (!parsed.success) throw Error("Invalid E2E control frame");
  const bytes = Buffer.from(JSON.stringify(parsed.data));
  if (bytes.length > MAX_CONTROL) throw Error("E2E control frame exceeds its limit");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(bytes.length);
  return Buffer.concat([
    CONTROL_MARKER,
    size,
    authentication(secret, "header", size),
    authentication(secret, "payload", size, bytes),
    bytes,
  ]);
}
/** Authenticate header/length before buffering a control body; never emit the secret. */
export class E2EControlDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly secret: Buffer;
  constructor(
    nonce: string,
    private readonly output: (bytes: Buffer) => void,
    private readonly receive: (frame: E2EControl) => void,
  ) {
    this.secret = key(nonce);
  }
  private authenticatedHeader(): boolean {
    const at = CONTROL_MARKER.length;
    return (
      this.buffer.indexOf(CONTROL_MARKER) === 0 &&
      this.buffer.length >= at + 4 + AUTH_BYTES &&
      timingSafeEqual(
        this.buffer.subarray(at + 4, at + 4 + AUTH_BYTES),
        authentication(this.secret, "header", this.buffer.subarray(at, at + 4)),
      )
    );
  }
  write(bytes: Uint8Array): void {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    while (this.buffer.length) {
      const start = this.buffer.indexOf(CONTROL_MARKER);
      if (start < 0) {
        let keep = Math.min(CONTROL_MARKER.length - 1, this.buffer.length);
        while (
          keep &&
          !this.buffer.subarray(this.buffer.length - keep).equals(CONTROL_MARKER.subarray(0, keep))
        )
          keep--;
        const count = this.buffer.length - keep;
        if (count) this.output(this.buffer.subarray(0, count));
        this.buffer = this.buffer.subarray(count);
        return;
      }
      if (start) {
        this.output(this.buffer.subarray(0, start));
        this.buffer = this.buffer.subarray(start);
      }
      const sizeAt = CONTROL_MARKER.length;
      if (this.buffer.length < sizeAt + 4 + AUTH_BYTES) return;
      if (!this.authenticatedHeader()) {
        this.output(this.buffer.subarray(0, 1));
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      const size = this.buffer.readUInt32LE(sizeAt);
      if (size > MAX_CONTROL) throw Error("E2E control frame exceeds its limit");
      const payloadAt = sizeAt + 4 + AUTH_BYTES * 2,
        end = payloadAt + size;
      if (this.buffer.length < end) return;
      const payload = this.buffer.subarray(payloadAt, end),
        tag = this.buffer.subarray(sizeAt + 4 + AUTH_BYTES, payloadAt);
      if (
        !timingSafeEqual(
          tag,
          authentication(this.secret, "payload", this.buffer.subarray(sizeAt, sizeAt + 4), payload),
        )
      )
        throw Error("Invalid authenticated E2E control frame");
      let frame: unknown;
      try {
        frame = JSON.parse(payload.toString());
      } catch {
        throw Error("Invalid E2E control frame");
      }
      const parsed = controlSchema.safeParse(frame);
      if (!parsed.success) throw Error("Invalid E2E control frame");
      this.buffer = this.buffer.subarray(end);
      this.receive(parsed.data);
    }
  }
  end(allowTruncated = false): void {
    if (this.authenticatedHeader()) {
      if (!allowTruncated) throw Error("Truncated E2E control frame");
    } else if (this.buffer.length) this.output(this.buffer);
    this.buffer = Buffer.alloc(0);
  }
}
