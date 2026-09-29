// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The request-size guard shared by the routes that accept raw audio.
 *
 * `bodyLimit` rejects a declared Content-Length over the cap before reading
 * anything, and aborts a chunked upload once it passes the cap, so the gateway
 * never buffers an oversized payload. Routes still compare the buffered length
 * against `MAX_AUDIO_BYTES` as a backstop for an upload whose length was
 * unknown up front, answering with the same body.
 */

import { bodyLimit } from "hono/body-limit";
import { MAX_AUDIO_BYTES } from "./transcribe-service.js";

export const audioTooLargeBody = {
  error: `Audio body too large (max ${Math.floor(MAX_AUDIO_BYTES / (1024 * 1024))} MB)`,
  code: "PAYLOAD_TOO_LARGE",
} as const;

export const audioBodyLimit = bodyLimit({
  maxSize: MAX_AUDIO_BYTES,
  onError: (c) => c.json(audioTooLargeBody, 413),
});
