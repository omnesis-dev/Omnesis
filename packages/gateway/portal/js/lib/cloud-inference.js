// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export function isLoopbackInferenceUrl(raw) {
  try {
    const hostname = new URL(raw).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

/**
 * The company a built-in cloud backend sends inference content to, for the
 * remote-inference consent prompt. Other providers are named by their own label.
 */
const CLOUD_PROVIDER_LABELS = { codex: "OpenAI", "claude-code": "Anthropic", anthropic: "Anthropic", typesafe: "TypeSafe" };

export function cloudProviderLabel(providerId, fallbackLabel) {
  return CLOUD_PROVIDER_LABELS[providerId] ?? fallbackLabel;
}

/**
 * The cloud-inference question to ask before assigning `backendKey/modelName`,
 * or null when none is needed. `endpoint` names a backend that is not saved
 * yet (a decision backend's setup form): its URL decides, and its label names
 * the provider.
 */
export function remoteAssignmentConsent(overview, backendKey, modelName, endpoint = null) {
  if (overview.inference.allowRemoteInference === true) return null;
  if (endpoint?.url) {
    return isLoopbackInferenceUrl(endpoint.url) ? null : { modelName, providerLabel: endpoint.providerLabel ?? endpoint.url };
  }
  // TypeSafe at an endpoint of the operator's own: on this host it needs no
  // consent, elsewhere the consent names that endpoint rather than TypeSafe.
  const typesafe = overview.inference.typesafe;
  if (backendKey === "typesafe" && typesafe?.selfHosted) {
    return typesafe.onHost ? null : { modelName, providerLabel: typesafe.url };
  }
  const builtIn = cloudProviderLabel(backendKey, null);
  if (builtIn) return { modelName, providerLabel: builtIn };
  const backend = overview.inference.backends?.[backendKey] ?? overview.inference.decisionBackends?.[backendKey];
  if (backend?.url && isLoopbackInferenceUrl(backend.url)) return null;
  return { modelName, providerLabel: backend?.url ?? backendKey };
}

export function inferenceAssignmentPatch(role, assignment, enableRemote = false) {
  return { inference: { assignments: { [role]: assignment }, ...(enableRemote ? { allowRemoteInference: true } : {}) } };
}
