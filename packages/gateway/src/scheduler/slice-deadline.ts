// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The stop check a sliced writer op polls between its steps: true once the
 * scheduler asks for the writer back, or once `sliceMs` has passed since the
 * check was made. The op always finishes the step it is on.
 */
export function sliceDeadline(
  token: { requested(): boolean },
  sliceMs: number,
  clock: () => number = () => performance.now(),
): () => boolean {
  const deadline = clock() + sliceMs;
  return () => token.requested() || clock() >= deadline;
}
