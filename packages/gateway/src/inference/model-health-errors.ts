// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ModelHealthWarning } from "@omnesis/core";

export function describeModelFailure(
  error: unknown,
): Pick<ModelHealthWarning, "category" | "message"> {
  // Text is inspected only for classification; none of it leaves this function.
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const provider =
    record.provider && typeof record.provider === "object"
      ? (record.provider as Record<string, unknown>)
      : {};
  const detail = [record.message, record.code, record.type, provider.code, provider.type]
    .filter((value) => typeof value === "string")
    .join(" ");
  const status = Number(provider.status ?? record.status ?? 0);
  if (
    /quota|credit|billing|insufficient.balance|usage.limit|rate.limit|429/i.test(detail) ||
    status === 429
  )
    return { category: "quota", message: descriptionForCategory("quota") };
  if (
    /401|403|unauthori[sz]ed|authentication|invalid.api.key|permission.denied/i.test(detail) ||
    status === 401 ||
    status === 403
  )
    return { category: "authentication", message: descriptionForCategory("authentication") };
  if (/timed?\s*out|timeout/i.test(detail))
    return { category: "timeout", message: descriptionForCategory("timeout") };
  if (
    /5\d\d|unavailable|overload|connection|ECONN|ENOTFOUND|fetch failed|network/i.test(detail) ||
    status >= 500
  )
    return { category: "unavailable", message: descriptionForCategory("unavailable") };
  if (
    /400|404|not.found|model.*(?:missing|unknown)|configuration|invalid.*(?:url|model)|endpoint/i.test(
      detail,
    ) ||
    status === 400 ||
    status === 404
  )
    return { category: "configuration", message: descriptionForCategory("configuration") };
  return { category: "unknown", message: descriptionForCategory("unknown") };
}

export function descriptionForCategory(category: ModelHealthWarning["category"]): string {
  const descriptions: Record<ModelHealthWarning["category"], string> = {
    quota:
      "The provider reports a quota, billing, or rate limit. Check its usage limits and balance.",
    authentication:
      "The provider rejected authentication or access. Check its credentials and permissions.",
    timeout:
      "Model requests repeatedly timed out. Check the backend's availability and response time.",
    unavailable:
      "The inference backend is unavailable or cannot be reached. Check the service and network connection.",
    configuration:
      "The backend rejected the model or request configuration. Check the assigned model and endpoint settings.",
    unknown:
      "The model repeatedly failed to complete requests. Check the backend and model configuration.",
  };
  return descriptions[category];
}
