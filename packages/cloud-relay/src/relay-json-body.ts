// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { RelayError } from "./tunnels.js";
import type { IncomingMessage } from "node:http";

/** A bounded body with a deadline, so an unauthenticated slow sender can't hold admission. */
export async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const deadline = setTimeout(() => req.destroy(new Error("Request body deadline")), 5000);
  deadline.unref();
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      length += Buffer.byteLength(chunk);
      if (length > limit) throw new RelayError(413, "Request too large");
      chunks.push(Buffer.from(chunk));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new RelayError(400, "Invalid JSON");
    }
  } finally {
    clearTimeout(deadline);
  }
}
