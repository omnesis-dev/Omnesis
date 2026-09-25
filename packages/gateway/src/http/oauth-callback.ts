// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * OAuth-callback rendering helpers.
 *
 * The `/oauth/callback` route is publicly reachable — anyone who can
 * make a browser navigate to the gateway can send arbitrary query
 * strings here. Echoing the OAuth provider's `error=` value verbatim
 * is the bug we're closing: it makes the URL a one-shot reflected-XSS
 * sink. These helpers ensure every byte we render is either a fixed
 * string or has been HTML-escaped first.
 */

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  // Standard OAuth 2.0 error codes (RFC 6749 §4.1.2.1) — short, safe.
  access_denied: "You declined to authorize Omnesis.",
  invalid_request: "The OAuth provider rejected the request as malformed.",
  invalid_client: "The OAuth client credentials are misconfigured.",
  invalid_grant: "The authorization grant was rejected.",
  unauthorized_client: "The OAuth client is not authorized for this grant type.",
  unsupported_response_type: "The OAuth provider does not support the requested response type.",
  invalid_scope: "The requested scopes were rejected by the OAuth provider.",
  server_error: "The OAuth provider returned an internal error.",
  temporarily_unavailable: "The OAuth provider is temporarily unavailable.",
};

/**
 * Map an OAuth `error=` query param to a user-readable explanation.
 * Falls back to a generic "refusal" message — never echoes the raw
 * input back to the rendered HTML, since that surface is reachable
 * by anyone who can craft a redirect to the gateway.
 */
export function friendlyOauthError(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed && trimmed in OAUTH_ERROR_MESSAGES) {
    return OAUTH_ERROR_MESSAGES[trimmed];
  }
  return "The OAuth provider returned an error. Please retry from the Omnesis app.";
}

/**
 * Render a small self-contained HTML page for the OAuth callback
 * landing. Inputs that come from query strings (the flow id, state
 * field) flow only through `escapeHtml` — never untrusted markup.
 *
 * The page renders identically across providers / errors so a
 * crafted callback can't choose a "richer" branch with more attack
 * surface. Inline CSS keeps it standalone (no portal asset deps,
 * no `script-src` to worry about) since this URL is loaded in the
 * user's browser AFTER an external redirect.
 */
export function renderOauthCallbackPage(
  status: "success" | "error",
  message: string,
  flowId?: string,
): string {
  const isSuccess = status === "success";
  const heading = isSuccess ? "Authorization received" : "Authorization failed";
  const accent = isSuccess ? "#1f8a4c" : "#c0392b";
  const safeMessage = escapeHtml(message);
  const safeFlow = flowId ? escapeHtml(flowId) : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)} — Omnesis</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #fafafa; color: #1a1a1a; margin: 0; padding: 48px 16px; }
  main { max-width: 480px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  h1 { margin: 0 0 12px; font-size: 18px; color: ${accent}; }
  p { margin: 0 0 12px; line-height: 1.5; }
  code { background: #f0f0f0; padding: 1px 6px; border-radius: 3px; font-size: 12px; }
  .hint { color: #666; font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(heading)}</h1>
  <p>${safeMessage}</p>
  ${safeFlow ? `<p class="hint">Reference: <code>${safeFlow}</code></p>` : ""}
  <p class="hint">You can close this window and return to Omnesis.</p>
</main>
</body>
</html>`;
}

const HTML_ESCAPE_RE = /[&<>"'`=\/]/g;
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
  "=": "&#61;",
  "/": "&#47;",
};

/** Minimal HTML-attribute-safe escaper for the callback page. */
export function escapeHtml(s: string): string {
  return s.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPES[ch] ?? ch);
}
