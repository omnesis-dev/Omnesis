// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Deadlines shared by the entailment verifier's transports and its callers,
 * kept dependency-free so Brain modules can import them cheaply.
 */

/**
 * How long one verification may run once it is admitted. Structured
 * annotation assessments are long reasoning turns on a hosted model: measured
 * on a live gateway, their median is about 20 s and a large share run past
 * 45 s. Every transport timer in `entailment-loader.ts` is set to this, so no layer cuts a call
 * short of what its caller budgeted for, and callers' deadlines (see
 * {@link VERIFIER_FOREGROUND_DEADLINE_MS}) are built from it.
 */
export const VERIFIER_CALL_LIMIT_MS = 90_000;

/**
 * A foreground caller's whole deadline: a short wait for a verifier slot
 * (foreground checks queue ahead of background re-checks) plus one call.
 */
export const VERIFIER_FOREGROUND_DEADLINE_MS = 30_000 + VERIFIER_CALL_LIMIT_MS;
