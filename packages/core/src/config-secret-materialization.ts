// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Keep API keys out of `omnesis.json`.
 *
 * A config mutation that carries an inline `inference.backends.<key>.apiKey`
 * or `inference.decisionBackends.<key>.apiKey`
 * stores the key in the secret store and rewrites the body to reference it
 * (`apiKeySecret`). Every writer of the file goes through this — the gateway's
 * admin config routes, and the CLI when it edits the file while no gateway is
 * running — so the file never holds a plaintext key whichever path wrote it.
 */

import { randomBytes } from "node:crypto";
import {
  clearConfigSecretRefSync,
  parseConfigSecretRef,
  writeConfigSecretSync,
} from "./config-secrets.js";
import type { OmnesisConfig } from "@omnesis/config";

export interface ConfigSecretMaterialization {
  /** The mutation body with inline API keys replaced by secret references. */
  body: unknown;
  /** Secret references written for this mutation. */
  newRefs: string[];
  /** Secret references the config held before the mutation. */
  previousRefs: string[];
}

/**
 * Move inline API keys in a PUT or PATCH body into the secret store. A PATCH
 * also deletes the inline key the stored config may still hold.
 */
export function materializeConfigSecrets(
  body: unknown,
  currentConfig: OmnesisConfig,
  configDir: string,
  mode: "put" | "patch",
): ConfigSecretMaterialization {
  const previousRefs = collectConfigSecretRefs(currentConfig);
  if (!isRecord(body) || !isRecord(body.inference)) return { body, newRefs: [], previousRefs };
  const inference: Record<string, unknown> = { ...body.inference };
  const newRefs: string[] = [];
  for (const collection of BACKEND_COLLECTIONS) {
    const backends = inference[collection];
    if (!isRecord(backends)) continue;
    const next = materializeCollection(backends, collection, configDir, mode, newRefs);
    if (next) inference[collection] = next;
  }
  if (!newRefs.length) return { body, newRefs: [], previousRefs };
  return { body: { ...body, inference }, newRefs, previousRefs };
}

/**
 * The two config collections whose entries carry an API key: the
 * OpenAI-compatible backends and the decision backends.
 */
const BACKEND_COLLECTIONS = ["backends", "decisionBackends"] as const;
type BackendCollection = (typeof BACKEND_COLLECTIONS)[number];

function materializeCollection(
  backends: Record<string, unknown>,
  collection: BackendCollection,
  configDir: string,
  mode: "put" | "patch",
  newRefs: string[],
): Record<string, unknown> | null {
  let changed = false;
  const nextBackends: Record<string, unknown> = { ...backends };
  for (const [backendKey, patchValue] of Object.entries(backends)) {
    if (!isRecord(patchValue) || typeof patchValue.apiKey !== "string") continue;
    const secretName =
      collection === "backends"
        ? inferenceBackendApiKeySecretName(backendKey)
        : decisionBackendApiKeySecretName(backendKey);
    const ref = writeConfigSecretSync(secretName, patchValue.apiKey, { configDir });
    const nextBackend: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patchValue)) {
      if (key !== "apiKey") nextBackend[key] = value;
    }
    if (mode === "patch") nextBackend.apiKey = null;
    nextBackend.apiKeySecret = ref;
    nextBackends[backendKey] = nextBackend;
    newRefs.push(ref);
    changed = true;
  }
  return changed ? nextBackends : null;
}

/**
 * Settle the secret store after a mutation: a committed mutation clears the
 * references the new config no longer names; a rejected or failed one clears
 * the references it wrote.
 */
export function cleanupConfigSecretMaterialization(
  materialized: ConfigSecretMaterialization | null,
  committed: boolean,
  configDir: string,
  committedConfig?: OmnesisConfig,
): void {
  if (!materialized) return;
  const refs = committed
    ? refsRemovedByConfig(materialized.previousRefs, committedConfig ?? {})
    : materialized.newRefs;
  for (const ref of refs) clearConfigSecretRefSync(ref, configDir);
}

/** A unique secret-store name for one inference backend's API key. */
export function inferenceBackendApiKeySecretName(backendKey: string): string {
  const encodedBackend = Buffer.from(backendKey, "utf8").toString("base64url");
  return `inference.backend.${encodedBackend}.apiKey.${randomBytes(6).toString("hex")}`;
}

/** A unique secret-store name for one decision backend's API key. */
export function decisionBackendApiKeySecretName(backendKey: string): string {
  const encodedBackend = Buffer.from(backendKey, "utf8").toString("base64url");
  return `inference.decision-backend.${encodedBackend}.apiKey.${randomBytes(6).toString("hex")}`;
}

function refsRemovedByConfig(previousRefs: string[], committedConfig: OmnesisConfig): string[] {
  const committedRefs = new Set(collectConfigSecretRefs(committedConfig));
  return previousRefs.filter((ref) => !committedRefs.has(ref));
}

function collectConfigSecretRefs(config: OmnesisConfig): string[] {
  const refs = new Set<string>();
  const entries = [
    ...Object.values(config.inference?.backends ?? {}),
    ...Object.values(config.inference?.decisionBackends ?? {}),
  ];
  for (const backend of entries) {
    const ref = backend.apiKeySecret;
    if (typeof ref === "string" && parseConfigSecretRef(ref)) refs.add(ref);
  }
  return [...refs];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
