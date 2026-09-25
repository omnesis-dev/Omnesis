// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Pre-launch access gate for omnesis.dev (Cloudflare Worker in front of the
// static assets). Everything is public EXCEPT the pages listed in isGated(),
// which sit behind HTTP Basic Auth until the repo goes public: the installer
// clones the not-yet-public repository. The docs and guided install prompt are
// public but unlisted — no public page links them, and isUnlisted() keeps search
// engines out.
//
// Temporary: delete this Worker and revert wrangler.jsonc (back to assets-only)
// when the repo goes public.

const PASSWORD = "indexmylife"; // shared password; any username is accepted.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const redirectPath = mobilePrivacyRedirectPath(url.pathname);
    if (redirectPath) {
      return new Response(null, {
        status: 301,
        headers: { Location: `${redirectPath}${url.search}` },
      });
    }

    const { pathname } = url;
    if (isGated(pathname) && !authorized(request)) {
      return new Response("Authentication required.", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Omnesis", charset="UTF-8"',
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }
    const response = await env.ASSETS.fetch(request);
    if (!isUnlisted(pathname)) return response;
    const unlisted = new Response(response.body, response);
    unlisted.headers.set("X-Robots-Tag", "noindex, nofollow");
    return unlisted;
  },
};

export function mobilePrivacyRedirectPath(pathname) {
  const p = normalizePathname(pathname);
  return p === "/privacy-policy" || p === "/privacy-policy.html" ? "/mobile-privacy-policy" : null;
}

export function isGated(pathname) {
  const p = normalizePathname(pathname);
  return p === "/install.sh" || p === "/readme.md";
}

export function isUnlisted(pathname) {
  const p = normalizePathname(pathname);
  return p === "/install-prompt.md" || p === "/docs" || p.startsWith("/docs/");
}

function normalizePathname(pathname) {
  return pathname.replace(/\/+$/, "").toLowerCase() || "/";
}

export function authorized(request) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  const password = sep === -1 ? decoded : decoded.slice(sep + 1);
  return password === PASSWORD;
}
