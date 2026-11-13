// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { readPrivateJson, savePrivateJson } from "./google-credentials.js";
import type { DirectCandidate } from "./direct-path.js";

/**
 * Keep the gateway's home addresses a running adapter learned, so the next start, possibly away
 * from home and before any refresh can succeed, begins from them instead of from the pairing's.
 * The file is re-read first: a pairing made since this adapter started owns it, and is left alone.
 */
export async function saveDirectCandidates(
  path: string,
  device: { deviceId: string; token: string },
  candidates: DirectCandidate[],
): Promise<void> {
  const saved = z
    .object({ deviceId: z.string(), token: z.string() })
    .passthrough()
    .parse(await readPrivateJson(path));
  if (saved.deviceId !== device.deviceId || saved.token !== device.token) return;
  await savePrivateJson(path, { ...saved, directCandidates: candidates });
}
