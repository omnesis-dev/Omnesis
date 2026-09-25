// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { CapabilityRole } from "./capabilities.js";

/** A model's selectable controls, reported for the exact serving provider and model ID. */
export type ModelControlKey = "reasoningEnabled" | "reasoningEffort" | "reasoningBudgetTokens";

export interface ModelControlDescriptor {
  key: ModelControlKey;
  type: "boolean" | "enum" | "integer";
  label: string;
  /** Exact effort values published by the serving provider. */
  values?: string[];
  min?: number;
  max?: number;
  /** Selecting this field clears other mutually exclusive provider controls. */
  exclusiveWith?: ModelControlKey[];
}

export interface ModelBehaviorValues {
  reasoningEnabled?: boolean;
  reasoningEffort?: string;
  reasoningBudgetTokens?: number;
}

export interface ModelControls {
  providerId: string;
  providerName?: string;
  source: "models.dev" | "provider" | "unknown";
  reasoning: boolean | null;
  controls: ModelControlDescriptor[];
  modalities?: { input: string[]; output: string[] };
  toolCall?: boolean;
  /** Exact reasoning side channel to replay on assistant tool-call messages. */
  interleavedReasoningField?: "reasoning_content" | "reasoning_details";
  /** Gateway-served URL; clients never fetch a logo from Models.dev. */
  logoUrl: string;
}

/** Saved values are tied to one assignment so a model switch cannot inherit stale controls. */
export interface ModelSettings {
  assignment: string | null;
  values: ModelBehaviorValues;
}

export type ModelSettingsByRole = Partial<Record<CapabilityRole, ModelSettings>>;
