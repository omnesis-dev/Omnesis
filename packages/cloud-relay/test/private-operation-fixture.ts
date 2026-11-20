// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Invented receipts substitute only the native ownership boundary; no live child is abandoned. */
export function markedFileError(
  code: string,
  placement: "own" | "cause",
): Error & { code: string } {
  const marker = { cleanupFailure: undefined };
  return Object.assign(
    new Error("Invented unjoined private operation"),
    { code },
    placement === "own"
      ? marker
      : { cause: Object.assign(new Error("Invented inner owned receipt"), marker) },
  );
}
export async function onWindowsBoundary<T>(operation: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}
