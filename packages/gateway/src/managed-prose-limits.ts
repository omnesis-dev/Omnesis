// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Legacy prose is bounded before encryption; envelopes need base64 and metadata headroom. */
export const MAX_MANAGED_PROSE_BYTES = 262_144;
export function proseSerializedByteLimit(decodedBytes: number): number {
  return 4 * Math.ceil(decodedBytes / 3) + 8192;
}
export const MAX_MANAGED_PROSE_SERIALIZED_BYTES = proseSerializedByteLimit(MAX_MANAGED_PROSE_BYTES);
