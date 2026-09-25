// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { hostIsOwned } from "@omnesis/core/url-normalize";

/**
 * The capture policy of the Web Pages source — the contract between the
 * gateway, which owns it, and every paired browser, which enforces it.
 *
 * Capture settings are stored once, on the gateway, so a domain excluded in one
 * browser is excluded in all of them, a pause pauses every browser, and a page
 * the user deleted "for good" is never captured again anywhere. Browsers read
 * the policy over HTTP with their `write:web` token, cache it, and refuse to
 * capture until they hold one. This module is dependency-free apart from core's
 * browser-safe URL helpers, so it bundles into the extension's service worker
 * unchanged.
 */

/** A shared capture pause. `until: null` pauses until someone resumes. */
export interface WebCapturePause {
  until: number | null;
}

/** Built-in privacy rules every browser applies on top of the exclusion list. */
export interface WebCaptureRules {
  /** Skip a page whose DOM carries a password field: sign-in, checkout, account pages. */
  skipPasswordForms: boolean;
  /** Skip a page whose URL path contains one of these segments (case-insensitive, whole segment). */
  skipPathSegments: string[];
}

/** The operator-editable half of the policy, as the gateway stores it. */
export interface WebCaptureSettings {
  pause: WebCapturePause | null;
  /** Bare lowercase hostnames; an entry also covers every subdomain. */
  excludedDomains: string[];
}

/** The wire shape of `GET /web-capture-policy`. */
export interface WebCapturePolicy extends WebCaptureSettings {
  /** ISO time the settings last changed; empty when they were never edited. */
  updatedAt: string;
  /** Hosts a dedicated source already covers; the gateway aggregates them from the collector. */
  ownedDomains: string[];
  rules: WebCaptureRules;
  /** External ids (SHA-256 of the normalized URL) of pages deleted with "never capture again". */
  removedPages: string[];
  /** True when `removedPages` was cut at the response cap; the gateway still refuses the rest on ingest. */
  removedPagesTruncated: boolean;
}

export const EMPTY_WEB_CAPTURE_SETTINGS: WebCaptureSettings = { pause: null, excludedDomains: [] };

/**
 * Conservative defaults: path segments that name authentication, payment and
 * account-management flows, where the rendered page is a form about the user
 * rather than content worth indexing.
 */
export const DEFAULT_WEB_CAPTURE_RULES: WebCaptureRules = {
  skipPasswordForms: true,
  skipPathSegments: [
    "login",
    "logout",
    "signin",
    "sign-in",
    "signup",
    "sign-up",
    "register",
    "password",
    "reset-password",
    "forgot-password",
    "oauth",
    "oauth2",
    "sso",
    "checkout",
    "payment",
    "payments",
    "billing",
  ],
};

/** Upper bound on `removedPages` in one policy response. */
export const REMOVED_PAGES_RESPONSE_CAP = 5_000;

/** Longest hostname the policy accepts. */
export const MAX_CAPTURE_DOMAIN_CHARS = 253;

/**
 * Normalize a user-entered domain to a bare lowercase hostname. Accepts a pasted
 * URL (`https://www.example.com/x`), a bare host (`Example.com`), or a host with
 * a leading dot, and returns the hostname (`example.com` / `www.example.com`).
 * A single-label host (`intranet`, `localhost`) is not a public domain and is
 * refused. Returns `""` for input with no usable host so the caller can reject it.
 */
export function normalizeCaptureDomain(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/^\.+/, "");
  if (!trimmed) return "";
  let host: string;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`);
    host = url.hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return "";
  }
  if (!host || host.length > MAX_CAPTURE_DOMAIN_CHARS) return "";
  if (/^\d+(?:\.\d+){3}$/.test(host)) {
    return host.split(".").every((octet) => Number(octet) <= 255) ? host : "";
  }
  const labels = host.split(".");
  return labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
    ? host
    : "";
}

/** Whether a pause is in force at `now`; a lapsed deadline reads as resumed. */
export function pauseActive(pause: WebCapturePause | null, now: number): boolean {
  if (!pause) return false;
  return pause.until === null || pause.until > now;
}

/** Remaining pause time in ms for a timed pause, or `null` for an indefinite pause / when resumed. */
export function pauseRemainingMs(pause: WebCapturePause | null, now: number): number | null {
  if (!pause || pause.until === null || !pauseActive(pause, now)) return null;
  return Math.max(0, pause.until - now);
}

/** Whether any path segment of `pathname` equals one of `segments` (case-insensitive). */
export function pathHasSkippedSegment(pathname: string, segments: readonly string[]): boolean {
  if (segments.length === 0) return false;
  const wanted = new Set(segments.map((segment) => segment.toLowerCase()));
  for (const raw of pathname.split("/")) {
    let segment = raw.toLowerCase();
    try {
      segment = decodeURIComponent(segment);
    } catch {
      // A malformed escape is compared literally.
    }
    if (segment && wanted.has(segment)) return true;
  }
  return false;
}

export type CaptureRefusal =
  | "invalid-url"
  | "gateway-host"
  | "excluded-domain"
  | "owned-domain"
  | "skipped-path"
  | "paused"
  | "removed-page";

export type CaptureVerdict = { allowed: true } | { allowed: false; reason: CaptureRefusal };

/**
 * Judge one page URL against the policy. The gateway's own host is refused so
 * a browser never indexes the Omnesis portal into the corpus. `externalId` is
 * the page's content-plane id when the caller has computed it; without it the
 * removed-pages check is skipped.
 */
export function judgeCaptureUrl(
  policy: WebCapturePolicy,
  url: string,
  context: { gatewayHost: string; now: number; externalId?: string },
): CaptureVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "invalid-url" };
  }
  const host = parsed.hostname.toLowerCase();
  if (hostIsOwned(host, [context.gatewayHost])) return { allowed: false, reason: "gateway-host" };
  if (hostIsOwned(host, policy.excludedDomains)) {
    return { allowed: false, reason: "excluded-domain" };
  }
  if (hostIsOwned(host, policy.ownedDomains)) return { allowed: false, reason: "owned-domain" };
  if (pathHasSkippedSegment(parsed.pathname, policy.rules.skipPathSegments)) {
    return { allowed: false, reason: "skipped-path" };
  }
  if (pauseActive(policy.pause, context.now)) return { allowed: false, reason: "paused" };
  if (context.externalId !== undefined && policy.removedPages.includes(context.externalId)) {
    return { allowed: false, reason: "removed-page" };
  }
  return { allowed: true };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPause(value: unknown): value is WebCapturePause | null {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const until = (value as { until?: unknown }).until;
  return until === null || (typeof until === "number" && Number.isFinite(until));
}

export function isWebCaptureRules(value: unknown): value is WebCaptureRules {
  if (typeof value !== "object" || value === null) return false;
  const rules = value as Partial<WebCaptureRules>;
  return typeof rules.skipPasswordForms === "boolean" && isStringArray(rules.skipPathSegments);
}

/** Structural guard for a policy read off the wire or out of a cache. */
export function isWebCapturePolicy(value: unknown): value is WebCapturePolicy {
  if (typeof value !== "object" || value === null) return false;
  const policy = value as Partial<WebCapturePolicy>;
  return (
    typeof policy.updatedAt === "string" &&
    isPause(policy.pause) &&
    isStringArray(policy.excludedDomains) &&
    isStringArray(policy.ownedDomains) &&
    isWebCaptureRules(policy.rules) &&
    isStringArray(policy.removedPages) &&
    typeof policy.removedPagesTruncated === "boolean"
  );
}
