// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared helpers for the synthetic-provider framework.
 *
 * Synth provider packages spread their real counterpart's `defineProvider` /
 * `defineSource` export and override only the auth lifecycle and per-source
 * `create()` factory. The real package owns icon/name/description/url
 * patterns/etc.; the synth package owns auth-shim + fixture emission.
 */

export type {
  Person,
  PersonAliases,
  Org,
  Cast,
  PersonRef,
  ResolvedPerson,
  ResolvedPersonMention,
  SynthCursor,
} from "./types.js";

export { loadCast, getPerson, resolvePerson, personMention, selfAccountId } from "./cast.js";

export {
  SYNTH_BATCH_SIZE,
  pageFromFixture,
  syncFromFixture,
  sha256Hex,
  type DocIdentity,
} from "./sync.js";

export { fakeOAuthFlow, fakeLocalFlow, fakeQrSession, preDiscoveredAccounts } from "./auth.js";

export {
  readImpairment,
  impairEntries,
  impairedSnapshot,
  impairedIds,
  synthPartitionOf,
  SYNTH_UNREADABLE_PARTITION,
  type SynthImpairment,
  type SynthImpairmentMode,
} from "./impairment.js";

export {
  loadActiveUniverse,
  loadUniverse,
  loadSourceFixtureJson,
  loadCastFromUniverse,
  getAgentDemosDir,
  getUniversesDir,
  getRepoRoot,
  resetActiveUniverseCache,
  validateUniverse,
  sourceDeviceAssignments,
  sourceHostAssignments,
  type UniverseMultiDeviceMode,
  hostingDeviceKinds,
  ROSTER_DEVICE_KINDS,
  UniverseError,
  type Universe,
  type UniverseManifest,
  type UniverseDeviceEntry,
  type UniverseSourceEntry,
  type UniverseIssue,
} from "./universe.js";
