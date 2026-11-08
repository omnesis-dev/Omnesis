// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tiny dedicated worker thread for SVG → PNG rasterization.
 *
 * Resvg's `render()` is a synchronous native call. Running it on the main HTTP
 * event loop blocks every other request for that window. This worker owns the
 * Resvg native binding so the main thread just sends bytes and awaits a PNG.
 *
 * Pool size is 1 — rasterize is rare (memoized at the call site), and a
 * single worker keeps init cost down. If the workload ever justifies a
 * pool, fan in `parentPort` against a queue here.
 *
 * Protocol:
 *   main → worker: { id: number, svgBytes: Uint8Array, targetSize: number }
 *   worker → main: { id, ok: true, png: string (base64) } |
 *                  { id, ok: false, error: string }
 */

import { parentPort } from "node:worker_threads";
import { rasterizeSvgToPngBase64 } from "./icon-rasterize.js";

if (!parentPort) {
  throw new Error("icon-rasterize-worker must run as a Node worker_thread");
}

interface RasterizeRequest {
  id: number;
  svgBytes: Uint8Array;
  targetSize: number;
}

parentPort.on("message", (msg: RasterizeRequest) => {
  try {
    parentPort!.postMessage({
      id: msg.id,
      ok: true,
      png: rasterizeSvgToPngBase64(Buffer.from(msg.svgBytes), msg.targetSize),
    });
  } catch (err) {
    parentPort!.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
