// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { OwnedChildProcess } from "@omnesis/core";

export interface FixtureOpenSslOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function runFixtureOpenSsl(
  args: readonly string[],
  options?: FixtureOpenSslOptions,
  observe?: (owner: OwnedChildProcess) => void,
): Promise<void>;
