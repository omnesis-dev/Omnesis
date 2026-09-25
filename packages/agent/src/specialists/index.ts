// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Private specialist registry for owned workflows. A specialist owns the child
 * session's system prompt, model role, and default read-tool allowlist; the
 * registry resolves a name and fails cleanly on an unknown profile.
 */

export {
  defineSpecialist,
  SpecialistRegistry,
  UnknownSpecialistError,
  type SpecialistDescriptor,
} from "./define-specialist.js";
export {
  BUILTIN_SPECIALISTS,
  researchPlannerSpecialist,
  historySweepSpecialist,
  sourceDigestSpecialist,
  citationVerifierSpecialist,
} from "./built-ins.js";
export {
  verifyQuotes,
  type QuoteVerification,
  type QuoteVerificationReport,
} from "./verify-quotes.js";

import { BUILTIN_SPECIALISTS } from "./built-ins.js";
import { SpecialistRegistry } from "./define-specialist.js";

/** Build a registry seeded with the v1 built-in specialists. */
export function createBuiltinSpecialistRegistry(): SpecialistRegistry {
  return new SpecialistRegistry(BUILTIN_SPECIALISTS);
}
