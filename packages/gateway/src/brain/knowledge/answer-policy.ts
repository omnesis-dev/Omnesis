// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { QualifiedKnowledgeSupport } from "./qualified-support.js";

export interface KnowledgeAnswerOptions {
  allowVerifiedAnswers?: boolean;
}

/** Qualified support grants the fast path only when the answering mode allows it. */
export function knowledgeAnswerPolicy(
  verifiedSupport: readonly QualifiedKnowledgeSupport[],
  options: KnowledgeAnswerOptions = {},
) {
  return {
    mode:
      options.allowVerifiedAnswers !== false && verifiedSupport.length
        ? ("verified_support" as const)
        : ("source_checks" as const),
  };
}

export function knowledgeAnswerGuidance(
  verifiedSupport: readonly QualifiedKnowledgeSupport[],
  options: KnowledgeAnswerOptions = {},
): string {
  const permission =
    options.allowVerifiedAnswers === false
      ? "answerPolicy.mode is source_checks: this answering mode requires source checks even when verifiedSupport contains qualified statements. Always read the supporting source documents before using these claims as facts."
      : verifiedSupport.length
        ? "answerPolicy.mode is verified_support: you may answer directly from the exact statements returned in verifiedSupport without reopening their sources merely to verify them again. Preserve each statement's interpretation context, attribution, modality, conditions and time bounds; this permission covers only those statements, not other prose or omitted claims."
        : "answerPolicy.mode is source_checks: no qualified statements are available in this read. Check source documents before using its claims as facts.";
  return `${permission} Keep the normal citation requirements for the records you use. Look for later evidence when the question asks for the latest or current status, and reconcile conflicting records before answering. A stored tracking state describes what Omnesis recorded, not proof that an obligation remains outstanding.`;
}
