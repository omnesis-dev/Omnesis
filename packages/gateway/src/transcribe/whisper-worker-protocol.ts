// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Wire protocol between the Whisper supervisor (`whisper-transcriber.ts`) and
 * the isolated worker subprocess (`whisper-worker.ts`).
 *
 * Why a subprocess at all: whisper.cpp is a native binding, and a native
 * segfault is process-wide — a Node `worker_thread` shares the process and
 * would take the gateway down with it. Only a separate OS process isolates the
 * crash, so the supervisor can observe a non-zero/signal exit, return null, and
 * stay alive. See the supervisor for the full rationale.
 *
 * Two channels, both over the child's own stdio so no extra fds are needed:
 *   - **stdin (parent → worker):** length-prefixed binary frames. Each frame is
 *     a 4-byte big-endian header length, a UTF-8 JSON header, then the raw PCM
 *     bytes. PCM rides as a binary tail rather than JSON so a multi-MB clip
 *     isn't base64-inflated through a JSON string.
 *   - **stdout (worker → parent):** length-prefixed UTF-8 JSON frames (results
 *     and errors are small, so no binary tail). `ready` is emitted once after
 *     the model loads.
 * stderr is left free for the worker's logger.
 *
 * Frames are length-prefixed (not newline-delimited) because PCM is arbitrary
 * binary and a JSON header could contain any byte; a length prefix is the only
 * framing that survives binary payloads.
 */

/** A transcription request: which clip (`id`), the PCM tail length, and opts. */
export interface WhisperRequestHeader {
  type: "request";
  id: number;
  /** Byte length of the PCM Float32 tail that follows this header. */
  pcmBytes: number;
  /** ISO-639-1 hint or "auto". */
  language: string;
}

/** Worker → parent: emitted once after the model is loaded and ready to serve. */
export interface WhisperReadyMessage {
  type: "ready";
}

/** Worker → parent: a successful transcription for request `id`. */
export interface WhisperResultMessage {
  type: "result";
  id: number;
  text: string;
  language?: string;
  durationSec?: number;
}

/** Worker → parent: a per-request failure (decode/inference error), not a crash. */
export interface WhisperErrorMessage {
  type: "error";
  id: number;
  error: string;
}

export type WhisperWorkerMessage = WhisperReadyMessage | WhisperResultMessage | WhisperErrorMessage;

/**
 * Encode a length-prefixed frame: 4-byte big-endian header length, the UTF-8
 * JSON header, then the optional raw binary tail.
 */
export function encodeFrame(header: object, tail?: ArrayBufferView): Buffer {
  const headerJson = Buffer.from(JSON.stringify(header), "utf-8");
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(headerJson.byteLength, 0);
  if (!tail || tail.byteLength === 0) {
    const frame = Buffer.allocUnsafe(4 + headerJson.byteLength);
    len.copy(frame, 0);
    headerJson.copy(frame, 4);
    return frame;
  }
  const frame = Buffer.allocUnsafe(4 + headerJson.byteLength + tail.byteLength);
  len.copy(frame, 0);
  headerJson.copy(frame, 4);
  Buffer.from(tail.buffer, tail.byteOffset, tail.byteLength).copy(frame, 4 + headerJson.byteLength);
  return frame;
}

/**
 * Incremental decoder for the length-prefixed frame stream. Feed it stdout/stdin
 * chunks; it invokes `onFrame(header, tail)` for each complete frame. `tail` is a
 * zero-copy view into the accumulated buffer — copy it if it must outlive the
 * callback.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly onFrame: (header: unknown, tail: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.byteLength === 0 ? chunk : (Buffer.concat([this.buf, chunk]) as Buffer);
    for (;;) {
      if (this.buf.byteLength < 4) return;
      const headerLen = this.buf.readUInt32BE(0);
      // We don't know the tail length from the prefix alone — the header
      // carries it (`pcmBytes`). Parse the header first, then wait for its tail.
      if (this.buf.byteLength < 4 + headerLen) return;
      const headerJson = this.buf.subarray(4, 4 + headerLen).toString("utf-8");
      let header: unknown;
      try {
        header = JSON.parse(headerJson);
      } catch {
        // Unparseable header means the stream is corrupt; drop everything so we
        // don't loop forever on a bad prefix.
        this.buf = Buffer.alloc(0);
        return;
      }
      const tailLen = frameTailLength(header);
      const frameEnd = 4 + headerLen + tailLen;
      if (this.buf.byteLength < frameEnd) return;
      const tail = this.buf.subarray(4 + headerLen, frameEnd);
      this.onFrame(header, tail);
      this.buf = this.buf.subarray(frameEnd);
    }
  }
}

/** A request header declares its PCM tail length; every other frame has none. */
function frameTailLength(header: unknown): number {
  if (
    typeof header === "object" &&
    header !== null &&
    (header as { type?: unknown }).type === "request"
  ) {
    const n = (header as { pcmBytes?: unknown }).pcmBytes;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
  }
  return 0;
}
