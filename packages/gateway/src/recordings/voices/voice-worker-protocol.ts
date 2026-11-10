// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Wire protocol between the voice separator (`local-voice-separator.ts`) and
 * its worker subprocess (`voice-worker.ts`). The runtime is a native ONNX
 * binding, so it runs in its own process for the reason the Whisper worker
 * does: a native crash ends the worker, not the gateway. Frames reuse the
 * Whisper worker's length-prefixed framing; a request's binary tail (PCM for
 * `separate`, packed vectors for `group`) is `pcmBytes` long.
 */

export { encodeFrame, FrameDecoder } from "../../transcribe/whisper-worker-protocol.js";

export interface VoiceRequestHeader {
  type: "request";
  id: number;
  op: "separate" | "group";
  /** Length of the binary tail in bytes. */
  pcmBytes: number;
  /** `group`: how many vectors the tail holds. */
  count?: number;
  /** `group`: the similarity at which two groups are one speaker. */
  threshold?: number;
}

export type VoiceWorkerMessage =
  | { type: "ready" }
  | {
      type: "result";
      id: number;
      /** `separate`: voice windows, ms from the start of the clip. */
      windows?: { startMs: number; endMs: number }[];
      /** `separate`: one vector per window. */
      vectors?: number[][];
      /** `group`: a 0-based speaker per vector. */
      labels?: number[];
    }
  | { type: "error"; id: number; error: string };
