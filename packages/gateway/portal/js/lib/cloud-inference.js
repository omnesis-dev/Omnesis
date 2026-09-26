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

export function remoteAssignmentConsent(overview, backendKey, modelName) {
  if (overview.inference.allowRemoteInference === true) return null;
  if (backendKey === "codex") return { modelName, providerLabel: "OpenAI" };
  if (backendKey === "anthropic") return { modelName, providerLabel: "Anthropic" };
  const backend = overview.inference.backends[backendKey];
  if (backend?.url && isLoopbackInferenceUrl(backend.url)) return null;
  return { modelName, providerLabel: backend?.url ?? backendKey };
}

export function inferenceAssignmentPatch(role, assignment, enableRemote = false) {
  return { inference: { assignments: { [role]: assignment }, ...(enableRemote ? { allowRemoteInference: true } : {}) } };
}
