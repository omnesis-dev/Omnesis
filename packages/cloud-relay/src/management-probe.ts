// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export async function probePublicMcp(origin: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", origin), {
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) return false;
  const { readBoundedJson } = await import("./google-credentials.js");
  const value = await readBoundedJson(response);
  return (
    typeof value === "object" &&
    value !== null &&
    "resource" in value &&
    value.resource === `${origin}/mcp`
  );
}
