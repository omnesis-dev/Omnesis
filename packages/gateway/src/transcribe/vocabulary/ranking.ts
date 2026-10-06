// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Persisted support and its admission index must use the same decay constant. */
export const AUTHORED_HALF_LIFE_DAYS = 90;

/** One independently dated contribution per document, with a 90-day half-life. */
export function authoredDecay(recordedAt: string, anchor: string): number {
  const ageDays = Math.max(0, (Date.parse(anchor) - Date.parse(recordedAt)) / 86400000);
  return Number.isFinite(ageDays) ? Math.pow(2, -ageDays / AUTHORED_HALF_LIFE_DAYS) : 0;
}

/**
 * Independent observations move confidence from a neutral symmetric prior
 * toward one. Effective authored mass supplies the observations, so historical
 * documents cannot restore confidence lost through temporal decay.
 */
export function vocabularyEvidenceConfidence(documents: number, priorDocuments = 10): number {
  if (!Number.isFinite(documents) || documents <= 0) return 0;
  if (!Number.isFinite(priorDocuments) || priorDocuments < 0) return 0;
  return (documents + priorDocuments) / (documents + 2 * priorDocuments);
}

/**
 * Distinctiveness refines recognition support rather than cancelling it.
 * Rarity weight blends inverse-log rarity with a neutral baseline; contextual
 * weight blends bounded frequency lift with neutral relevance. Zero ignores
 * that discriminator, while one retains its full strength.
 */
export function vocabularyDiscrimination(
  globalOccurrences: number,
  contextualLift: number,
  rarityWeight = 1,
  contextLiftWeight = 1,
): number {
  if (!Number.isFinite(globalOccurrences) || globalOccurrences < 0) return 0;
  const rarity = 1 / (1 + Math.log1p(globalOccurrences));
  const lift = Number.isFinite(contextualLift) ? Math.min(3, Math.max(1, contextualLift)) : 1;
  const boundedRarityWeight = Math.min(1, Math.max(0, rarityWeight));
  const boundedContextWeight = Math.min(1, Math.max(0, contextLiftWeight));
  return (
    (1 - boundedRarityWeight + boundedRarityWeight * rarity) *
    (1 + boundedContextWeight * (lift - 1))
  );
}

export interface VocabularyFrequencyEvidence {
  profileOccurrences: number;
  profileDocuments: number;
  globalOccurrences: number;
  globalDocuments: number;
}

/**
 * Positive frequency lift over the same freshly observed document cohort.
 * A background rate and ten-document prior shrink tiny profiles toward the
 * background. Old retained frequencies must never use a partially refreshed
 * denominator. Missing or incoherent evidence leaves existing ranking intact.
 */
export function contextualVocabularyLift(
  evidence: VocabularyFrequencyEvidence,
  priorDocuments = 10,
): number | undefined {
  const { profileOccurrences, profileDocuments, globalOccurrences, globalDocuments } = evidence;
  if (
    ![profileOccurrences, profileDocuments, globalOccurrences, globalDocuments].every(
      (value) => Number.isFinite(value) && value >= 0,
    ) ||
    profileOccurrences < 2 ||
    globalOccurrences < 2 ||
    profileOccurrences > profileDocuments ||
    profileOccurrences > globalOccurrences ||
    globalOccurrences > globalDocuments ||
    profileDocuments > globalDocuments ||
    !Number.isFinite(priorDocuments) ||
    priorDocuments < 0
  )
    return undefined;
  const background = (globalOccurrences + 0.5) / (globalDocuments + 1);
  const contextual =
    (profileOccurrences + priorDocuments * background) / (profileDocuments + priorDocuments);
  return 1 + Math.min(2, Math.max(0, Math.log(contextual / background)));
}
