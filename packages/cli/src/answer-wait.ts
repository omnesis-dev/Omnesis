// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** One bounded approval checkpoint before an agent harness regains control. */
export const DEFAULT_ANSWER_WAIT_TIMEOUT_S = 60;

/** Foreground fallback stays below a typical one-minute harness turn budget. */
export const FOREGROUND_ANSWER_WAIT_TIMEOUT_S = DEFAULT_ANSWER_WAIT_TIMEOUT_S - 5;

/** Harness process timeout leaves room for CLI startup and shutdown around the wait. */
export const HARNESS_ANSWER_WAIT_TIMEOUT_S = DEFAULT_ANSWER_WAIT_TIMEOUT_S + 15;

/** Longest explicit CLI wait accepted; agents should normally use the default checkpoint. */
export const MAX_ANSWER_WAIT_TIMEOUT_S = 3_600;

/** Keep approval detection responsive without putting meaningful read load on the gateway. */
export const ANSWER_WAIT_POLL_INTERVAL_MS = 5_000;
