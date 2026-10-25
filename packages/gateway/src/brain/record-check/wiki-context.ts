// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Bounded source-vetted context; the draft is judged for value, not factual truth. */
export interface WikiRecordContext {
  title: string;
  factualRepair?: {
    claimIds: string[];
    beforeMarkup: string;
    afterMarkup: string;
    beforeStates: unknown;
    afterStates: unknown;
  };
  previous?: { title: string; text: string; truncated: boolean };
  references: Array<{ ref: string; text: string; truncated: boolean }>;
  referencesOmitted: number;
}
