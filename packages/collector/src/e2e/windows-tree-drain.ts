// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

interface ObservedProcessTree {
  refresh(): Promise<void>;
  readonly alive: boolean;
}

/** An exit requires both a successful current snapshot and the original root's exit. */
export async function waitForWindowsTreeExit(
  tree: ObservedProcessTree,
  rootExited: () => boolean,
  graceMs: number,
): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  let uncertainty: { error: unknown } | undefined;
  for (;;) {
    try {
      await tree.refresh();
      uncertainty = undefined;
      if (!tree.alive && rootExited()) return true;
    } catch (error) {
      // A terminating Windows process can reject a metadata open briefly.
      // Keep ownership until a later snapshot succeeds; never infer exit here.
      uncertainty = { error };
    }
    if (Date.now() >= deadline) {
      if (uncertainty) throw uncertainty.error;
      return false;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
