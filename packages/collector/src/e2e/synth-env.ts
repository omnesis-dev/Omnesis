// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Side-effect-only module: sets `OMNESIS_SYNTHETIC=1` for the current worker
 * process so the collector's source-descriptors discovery loads the synthetic
 * provider packages instead of the real ones. Import this BEFORE any synth-
 * harness import in a test file.
 *
 * This flag belongs to the test process only. Each spawned gateway gets the
 * feature mode selected explicitly by `SyntheticE2EHarness.gatewayMode`.
 *
 *   import "./synth-env.js";
 *   import { SyntheticE2EHarness } from "./synth-harness.js";
 */
process.env.OMNESIS_SYNTHETIC = "1";
// Keep the auth-shim suite fast — demos use the default ~4s delay.
process.env.OMNESIS_SYNTH_AUTH_DELAY_MS = process.env.OMNESIS_SYNTH_AUTH_DELAY_MS ?? "50";
// E2E tests use the harness's discover-based source-config build, which needs
// synth `discover()` to return the synth identity. Demo flows leave this unset
// so the portal Add-Source wizard hits the auth/QR screen instead of
// short-circuiting on a pre-discovered account.
process.env.OMNESIS_SYNTH_PRE_DISCOVERED = process.env.OMNESIS_SYNTH_PRE_DISCOVERED ?? "1";
// Default to the `default` universe (= the migrated original corpus) so
// existing synth E2E tests pick up the relocated fixtures without changes.
// Tests that need a different universe set this themselves before importing
// the harness.
process.env.OMNESIS_SYNTH_UNIVERSE = process.env.OMNESIS_SYNTH_UNIVERSE ?? "default";
