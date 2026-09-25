// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_MAX_AGE_S,
  SESSION_COOKIE_BASE,
  SESSION_COOKIE_NAME,
  buildSessionCookieHeader,
  clearSessionCookieHeader,
  getSessionCookie,
  parseCookie,
  portalCsrfToken,
  sessionCookieName,
} from "./cookies.js";

describe("parseCookie", () => {
  it("returns undefined when the header is missing", () => {
    expect(parseCookie(undefined, "x")).toBeUndefined();
  });

  it("returns undefined when the cookie isn't present", () => {
    expect(parseCookie("a=1; b=2", "c")).toBeUndefined();
  });

  it("returns the value for a single-cookie header", () => {
    expect(parseCookie("session=abc", "session")).toBe("abc");
  });

  it("returns the value when the cookie is in the middle", () => {
    expect(parseCookie("a=1; session=abc; b=2", "session")).toBe("abc");
  });

  it("trims whitespace around the cookie name", () => {
    expect(parseCookie("a=1 ; session=abc ; b=2", "session")).toBe("abc ");
  });

  it("does NOT match a name that's a substring of another cookie name", () => {
    // Pre-fix bug: `name=([^;]*)` could match "session=" inside "supersession=".
    expect(parseCookie("supersession=evil; other=1", "session")).toBeUndefined();
  });

  it("does NOT match a name that's a suffix of another cookie name", () => {
    expect(parseCookie("xsession=evil; other=1", "session")).toBeUndefined();
  });

  it("treats the cookie name as a literal — regex metacharacters in the name name nothing special", () => {
    // Pre-fix bug: parseCookie(header, ".*") would have built a regex
    // that matched any cookie. The split-and-compare parser treats the
    // name as a string; nothing matches.
    expect(parseCookie("session=abc; other=1", ".*")).toBeUndefined();
    expect(parseCookie("session=abc", "se.sion")).toBeUndefined();
  });

  it("returns the empty string when the cookie has no value", () => {
    expect(parseCookie("session=; other=1", "session")).toBe("");
  });

  it("preserves '=' inside the value", () => {
    expect(parseCookie("token=abc=def=ghi; other=1", "token")).toBe("abc=def=ghi");
  });
});

describe("getSessionCookie", () => {
  it("delegates to parseCookie with the session cookie name", () => {
    expect(getSessionCookie(`${SESSION_COOKIE_NAME}=sess123; other=1`)).toBe("sess123");
    expect(getSessionCookie(undefined)).toBeUndefined();
    expect(getSessionCookie("other=1")).toBeUndefined();
  });
});

describe("sessionCookieName", () => {
  // RFC 6265 cookies aren't port-scoped: `localhost:7600` and
  // `localhost:27600` share the same cookie jar. Two gateways on the
  // same host with the bare `__omnesis_session` cookie would overwrite
  // each other in the browser, silently logging the user out of the
  // first one. Per-port names prevent that.
  it("returns the bare base name when no port is supplied", () => {
    expect(sessionCookieName()).toBe(SESSION_COOKIE_BASE);
    expect(sessionCookieName(undefined)).toBe(SESSION_COOKIE_BASE);
  });

  it("scopes the cookie name with the listen port", () => {
    expect(sessionCookieName(7600)).toBe(`${SESSION_COOKIE_BASE}_7600`);
    expect(sessionCookieName(27600)).toBe(`${SESSION_COOKIE_BASE}_27600`);
  });

  it("falls back to the base name when the port is non-finite", () => {
    expect(sessionCookieName(Number.NaN)).toBe(SESSION_COOKIE_BASE);
    expect(sessionCookieName(Number.POSITIVE_INFINITY)).toBe(SESSION_COOKIE_BASE);
  });

  it("produces names that do not collide as substrings of each other", () => {
    // Cookie header for gateway B (port 27600). A naïve substring
    // assertion like `header.includes("__omnesis_session=")` must NOT
    // accidentally match a port-scoped cookie — verify the boundary.
    const headerB = buildSessionCookieHeader("sessB", 60, sessionCookieName(27600));
    expect(headerB.includes(`${SESSION_COOKIE_BASE}=`)).toBe(false);
    expect(headerB).toContain(`${SESSION_COOKIE_BASE}_27600=sessB`);
  });
});

describe("portalCsrfToken", () => {
  it("derives a deterministic, session-bound token without returning the session id", () => {
    const sessionId = "session-secret-value";
    const token = portalCsrfToken(sessionId);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(token).not.toContain(sessionId);
    expect(portalCsrfToken(sessionId)).toBe(token);
    expect(portalCsrfToken("different-session")).not.toBe(token);
  });
});

describe("buildSessionCookieHeader / clearSessionCookieHeader", () => {
  it("emits the session cookie with the canonical attribute set", () => {
    const header = buildSessionCookieHeader("sess123");
    expect(header).toContain(`${SESSION_COOKIE_NAME}=sess123`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure"); // gateway is always HTTPS, so the bearer cookie must be Secure
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).toContain(`Max-Age=${DEFAULT_SESSION_MAX_AGE_S}`); // 30 days
  });

  it("honours an operator-supplied Max-Age (gateway.timings.sessionTtl override)", () => {
    // 7 days in seconds — operator might shorten the session cookie via
    // `gateway.timings.sessionTtl: "7d"` in `omnesis.json`.
    const sevenDays = 7 * 24 * 60 * 60;
    const header = buildSessionCookieHeader("sess123", sevenDays);
    expect(header).toContain(`Max-Age=${sevenDays}`);
    expect(header).not.toContain(`Max-Age=${DEFAULT_SESSION_MAX_AGE_S}`);
  });

  it("emits a clear-cookie header with Max-Age=0", () => {
    const header = clearSessionCookieHeader();
    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
  });

  it("uses a caller-supplied cookie name for build + clear", () => {
    const name = sessionCookieName(27600);
    const build = buildSessionCookieHeader("sess123", 60, name);
    expect(build.startsWith(`${name}=sess123`)).toBe(true);
    const clear = clearSessionCookieHeader(name);
    expect(clear.startsWith(`${name}=`)).toBe(true);
    expect(clear).toContain("Max-Age=0");
  });

  it("reads the session cookie by caller-supplied name", () => {
    const name = sessionCookieName(27600);
    expect(getSessionCookie(`${name}=sessB; other=1`, name)).toBe("sessB");
    // The bare base name must NOT match a port-scoped cookie (and vice
    // versa) — each gateway only sees its own cookie.
    expect(getSessionCookie(`${name}=sessB`, SESSION_COOKIE_BASE)).toBeUndefined();
    expect(getSessionCookie(`${SESSION_COOKIE_BASE}=sessA`, name)).toBeUndefined();
  });
});
