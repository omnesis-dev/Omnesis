// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ScopeRefreshEpochs } from "./source-scope-updates.js";
import type { PersonRole, PersonMention } from "./document.js";

/** Stable identifiers, captured when a filter is saved; never person-row IDs. */
export interface ScopeIdentifier {
  type: "phone" | "email" | "domain";
  value: string;
}

export type ScopeRef =
  | { kind: "conversation"; id: string }
  | { kind: "participant"; label: string; identifiers: ScopeIdentifier[] }
  | { kind: "label"; id: string }
  | { kind: "folder"; id: string };

/** Ask, Keep and Drop are reserved for V2 and rejected by the V1 boundary. */
export type ScopeAction = "share" | "hide" | "ask" | "keep" | "drop";
export interface ScopeRule {
  /** An OR list. The first matching rule decides. */
  match: ScopeRef[];
  action: ScopeAction;
}
export interface ScopePolicy {
  sourceId: string;
  audience: { accessLevel: string; capability: "direct" | "answer" } | "keep" | "brain";
  rules: ScopeRule[];
  otherwise: ScopeAction;
  /** Reserved for V2. */
  maxAge?: string;
}

/** Provider-owned description; shared consumers never branch on source names. */
export type SourceScopeItem =
  | {
      kind: "participant";
      identifiers: ScopeIdentifier["type"][];
      link: "fixed" | "changes";
    }
  | {
      kind: "conversation" | "label" | "folder";
      noun: { one: string; many: string };
      picker: "search" | "tree";
      link: "fixed" | "changes" | "hierarchy";
      /** Reserved for V2. */
      liveSearch?: boolean;
      /** Reserved for V2. */
      keep?: "before-cache";
    };
/** Native source facts; participant identifiers never refer to merged person rows. */
export type ScopeFact =
  | { kind: "conversation" | "label" | "folder"; id: string; label?: string }
  | { kind: "participant"; identifier: ScopeIdentifier };

/** Absence from complete means unknown, including when facts contains positive matches. */
export interface DocumentScopeFacts {
  /** Explicit producer proof for facts observed during required native refreshes. */
  refreshEpochs?: ScopeRefreshEpochs;
  /** Explicit kinds being replaced, including unknown kinds with no positive facts. */
  kinds?: ScopeRef["kind"][];
  facts: ScopeFact[];
  complete: ScopeRef["kind"][];
}

/** Source-owned recipe for deriving facts from metadata already stored on the gateway. */
export interface LegacyScopeProjection {
  /** Object keys beneath DocumentMetadata; missing or non-string values are unknown. */
  conversationIdPath?: string[];
  /** Optional display label; never used for matching. */
  conversationLabelPath?: string[];
  participants?: {
    /** Only these native mention roles participate; body-only mentions never do. */
    roles: Exclude<PersonRole, "mentioned">[];
    /** A metadata array at this producer limit may have omitted participants. */
    maxPeople?: number;
    /** Source-native authoritative roster envelope, distinct from that day's speakers. */
    snapshotPath?: string[];
    /** Conversation membership must be combined across all stored days before becoming complete. */
    membership: "document" | "conversation";
  };
}

export interface SourceScopes {
  /** Monotonic declaration generation; omission is the legacy generation 1. */
  revision?: number;
  items: SourceScopeItem[];
  legacyProjection?: LegacyScopeProjection;
}

/** Source-native conversation membership; revision is causal, never a wall-clock ordering. */
export interface SourceScopeConversationUpdate {
  refreshEpoch?: string;
  id: string;
  participants: PersonMention[];
  mode: "observed" | "snapshot";
  observedAt: string;
  revision: { epoch: string; sequence: number };
}
