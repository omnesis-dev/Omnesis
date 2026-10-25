// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AssignmentValue, HttpBackendConfig } from "./backends.js";

export const SPEECH_TO_SPEECH_MODEL = "gpt-live-1" as const;

/** Explicit media assignment only. Callers also enforce experimental mode, egress and credentials. */
export function speechToSpeechAssignment(
  value: AssignmentValue | undefined,
  backends: Readonly<Record<string, Pick<HttpBackendConfig, "type" | "url">>> | undefined,
): { backendKey: string; model: typeof SPEECH_TO_SPEECH_MODEL } | undefined {
  if (typeof value !== "string") return undefined;
  const slash = value.indexOf("/");
  if (slash < 1 || value.slice(slash + 1) !== SPEECH_TO_SPEECH_MODEL) return undefined;
  const backendKey = value.slice(0, slash);
  const backend = backends?.[backendKey];
  if (!backend || backend.type !== "http") return undefined;
  try {
    const url = new URL(backend.url);
    if (url.origin !== "https://api.openai.com" || url.username || url.password) return undefined;
  } catch {
    return undefined;
  }
  return { backendKey, model: SPEECH_TO_SPEECH_MODEL };
}
