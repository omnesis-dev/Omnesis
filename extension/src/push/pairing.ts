// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { compareProductVersions, parseProductVersion } from "@omnesis/core/client-version";
import { boundedGatewayReason, readBoundedResponseText } from "./response-body.js";
import type { FetchLike, FetchLikeResponse } from "./types.js";

/**
 * Pairing + gateway-URL validation for the browser-capture extension.
 *
 * Environment-agnostic (injected `fetch`) so the options page and tests share
 * one implementation.
 */

export interface PairResult {
  /** The paired device row the gateway created. */
  device: { id: string; name: string; kind: string };
  /** The `write:web`-scoped bearer token to store and push with. */
  token: string;
  /** Scopes the token carries (expected to be exactly `["write:web"]`). */
  scopes: string[];
  /** The gateway's product version from its health check, when it answered one. */
  gatewayVersion?: string;
}

/**
 * The oldest gateway a build of this extension pairs with: the first release
 * of its own minor. HTTP changes within a minor are additive, so a gateway on
 * the same minor (any patch) or newer speaks everything this build sends,
 * while a gateway on an older minor may lack routes or fields this build
 * relies on. Derived from the build's own version, so it moves with every
 * release instead of being maintained by hand. Unknown when the build's
 * version is not a product version (tests), in which case nothing is refused.
 */
export function minimumGatewayVersionFor(extensionVersion: string | undefined): string | null {
  const parsed = extensionVersion ? parseProductVersion(extensionVersion) : null;
  return parsed ? `${parsed.major}.${parsed.minor}.0` : null;
}

/** How long the health preflight may take before pairing proceeds without it. */
const HEALTH_PREFLIGHT_TIMEOUT_MS = 3_000;

const MAX_TOKEN_CHARS = 4_096;
const MAX_DEVICE_ID_CHARS = 256;
const MAX_DEVICE_NAME_CHARS = 256;
const MAX_DEVICE_KIND_CHARS = 64;
const MAX_SCOPE_COUNT = 16;
const MAX_SCOPE_CHARS = 128;

export class GatewayUrlError extends Error {
  constructor(message: string) {
    super(boundedGatewayReason(message));
    this.name = "GatewayUrlError";
  }
}

/**
 * The pairing request produced no HTTP response — it timed out or the
 * connection failed — so whether the gateway spent the code is unknown. The
 * caller keeps the attempt's idempotency key and resubmits the same code: the
 * gateway replays the first redemption if it happened, or performs it if not.
 * Anything answered with an HTTP status is a verdict and is not this error.
 */
export class PairingOutcomeUnknownError extends GatewayUrlError {
  constructor(cause: "timeout" | "network") {
    super(
      `${
        cause === "timeout"
          ? "Pairing request timed out."
          : "The connection to the gateway failed before it answered."
      } If the gateway is reachable, submit the same code again unchanged — the retry is safe.`,
    );
    this.name = "PairingOutcomeUnknownError";
  }
}

/**
 * Validate and normalize a gateway URL entered on the pairing screen.
 *
 * The transport requires a **browser-trusted certificate**:
 * a Tailscale-issued / mkcert hostname certificate covers the *hostname*, not
 * a bare IP literal. An MV3 `fetch()` to `https://<ip>` therefore fails the
 * TLS hostname check, so the pairing screen rejects IP literals up front with
 * a message pointing at the trusted-hostname requirement, rather than letting
 * the operator hit an opaque network error later.
 *
 * Rules:
 *   - must parse as a URL and use `https:` (the gateway is TLS-only);
 *   - the host must be a hostname, not an IPv4/IPv6 literal;
 *   - returns the origin (+ explicit port if present), no trailing slash.
 */
export function normalizeGatewayUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new GatewayUrlError("Enter the gateway URL.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new GatewayUrlError(
      "That doesn't look like a URL. Use the gateway's HTTPS hostname, e.g. https://gateway.example.ts.net:7600",
    );
  }

  if (url.protocol !== "https:") {
    throw new GatewayUrlError("The gateway URL must use https://.");
  }

  if (url.username || url.password) {
    throw new GatewayUrlError("The gateway URL must not contain a username or password.");
  }

  if (isIpLiteral(url.hostname)) {
    throw new GatewayUrlError(
      "Use the gateway's trusted hostname (its Tailscale / mkcert certificate name), not an IP address — the certificate covers the name, not the IP.",
    );
  }

  // Strip any path/query/fragment — only the origin is meaningful for pushes.
  const port = url.port ? `:${url.port}` : "";
  return `${url.protocol}//${url.hostname}${port}`;
}

/**
 * True if `host` is an IPv4 or (bracketed or bare) IPv6 literal. `URL`
 * lowercases and may bracket IPv6 hosts; we strip brackets before testing.
 */
export function isIpLiteral(host: string): boolean {
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // IPv4 dotted quad.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  // IPv6 — hex groups separated by colons (covers `::` compression).
  if (h.includes(":") && /^[0-9a-f:]+$/i.test(h)) return true;
  return false;
}

/**
 * Redeem a pairing code against `POST /devices/pair`.
 *
 * Mirrors the public pairing handshake (`packages/gateway/.../pairing.ts`):
 * body `{ pairingCode, capabilities }` → `{ device, token, scopes }`. The
 * extension announces itself as a `web`-platform device; the gateway assigns
 * the `browser` device kind (from the pairing code minted `--kind browser`)
 * and a `write:web`-only token — the device kind is the physical client, while
 * the scope limits it to contributing browser captures.
 */
export async function pair(
  gatewayUrl: string,
  pairingCode: string,
  fetchImpl: FetchLike,
  // Required (no default): the extension passes the user-entered Chrome
  // profile label. Stable install identity comes from `opts.installId`, so
  // duplicate human labels do not collapse two profiles onto one device row.
  suggestedName: string,
  opts: {
    installId?: string;
    previousDeviceId?: string;
    requestTimeoutMs?: number;
    /**
     * This extension build's product version, from the manifest. Passed in
     * rather than read here so this module stays free of the `chrome`
     * global and testable outside a browser. The extension never opens a
     * device socket — it pairs and pushes over HTTP — so pair time is the
     * only moment it can tell the gateway's version ledger what it is.
     */
    version?: string;
    /**
     * Crash-recovery key for this attempt (see `chrome/pairing-attempt.ts`).
     * A repeat request with the same code and key gets the first attempt's
     * credentials back instead of "invalid or expired pairing code".
     */
    idempotencyKey?: string;
  } = {},
): Promise<PairResult> {
  const { installId, version, idempotencyKey, requestTimeoutMs = 10_000 } = opts;
  // The gateway validates `previousDeviceId` as a UUID and rejects the whole
  // request otherwise. The only value the worker ever passes here is a device
  // id the gateway itself issued, so anything else is corrupt stored state —
  // drop it and pair as a fresh device rather than fail the pairing.
  const previousDeviceId =
    opts.previousDeviceId && UUID_PATTERN.test(opts.previousDeviceId)
      ? opts.previousDeviceId
      : undefined;
  const base = normalizeGatewayUrl(gatewayUrl);
  const code = pairingCode.trim();
  if (!code) throw new GatewayUrlError("Enter the pairing code from the gateway.");

  // A gateway too old for this extension fails later in confusing ways (an
  // unknown route, a rejected field). Ask its public health check first and
  // refuse plainly; a health check that does not answer is left to the pairing
  // request itself to report.
  const gatewayVersion = await readGatewayVersion(
    base,
    fetchImpl,
    Math.min(HEALTH_PREFLIGHT_TIMEOUT_MS, requestTimeoutMs),
  );
  const floor = minimumGatewayVersionFor(version);
  if (gatewayVersion !== null && floor !== null) {
    const order = compareProductVersions(gatewayVersion, floor);
    if (order !== null && order < 0) {
      throw new GatewayUrlError(
        `This gateway runs Omnesis ${gatewayVersion}; this extension (${version}) needs ${floor} or newer. Update the gateway, then pair again.`,
      );
    }
  }

  const controller = new AbortController();
  const deadline = Date.now() + requestTimeoutMs;
  const abortTimer = setTimeout(() => controller.abort(), requestTimeoutMs);
  let res: FetchLikeResponse;
  let text: string;
  try {
    res = await withTimeout(
      fetchImpl(`${base}/devices/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pairingCode: code,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          capabilities: {
            platform: "web",
            suggestedName,
            ...(version ? { version } : {}),
            ...(installId ? { installId } : {}),
            ...(previousDeviceId ? { previousDeviceId } : {}),
          },
        }),
        signal: controller.signal,
        redirect: "error",
      }),
      requestTimeoutMs,
    );
    text = await withTimeout(readBoundedResponseText(res), Math.max(1, deadline - Date.now()));
  } catch (error) {
    const timedOut =
      controller.signal.aborted || (error instanceof Error && error.message === "timed out");
    throw new PairingOutcomeUnknownError(timedOut ? "timeout" : "network");
  } finally {
    clearTimeout(abortTimer);
  }
  if (res.status < 200 || res.status >= 300) {
    let detail = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) detail = boundedGatewayReason(parsed.error);
    } catch {
      // non-JSON error body — keep the status-line detail.
    }
    throw new GatewayUrlError(`Pairing failed: ${detail}`);
  }

  let body: PairResult;
  try {
    body = JSON.parse(text) as PairResult;
  } catch {
    throw new GatewayUrlError("Pairing response was not valid JSON.");
  }
  if (!isPairResult(body))
    throw new GatewayUrlError("Pairing response was missing required fields.");
  if (body.device.kind !== "browser") {
    throw new GatewayUrlError(`Pairing created a ${body.device.kind} device instead of a browser.`);
  }
  assertWebScope(body.scopes);
  return gatewayVersion === null ? body : { ...body, gatewayVersion };
}

/**
 * The gateway's product version from its public `GET /health`, or null when
 * it cannot be read (unreachable, not JSON, no version field). Never throws:
 * the caller decides what an unknown version means.
 */
export async function readGatewayVersion(
  gatewayUrl: string,
  fetchImpl: FetchLike,
  timeoutMs = 10_000,
): Promise<string | null> {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await withTimeout(
      fetchImpl(`${normalizeGatewayUrl(gatewayUrl)}/health`, {
        method: "GET",
        headers: {},
        body: "",
        signal: controller.signal,
        redirect: "error",
      }),
      timeoutMs,
    );
    if (res.status < 200 || res.status >= 300) return null;
    const parsed = JSON.parse(await readBoundedResponseText(res)) as { version?: unknown };
    return typeof parsed.version === "string" && GATEWAY_VERSION_PATTERN.test(parsed.version)
      ? parsed.version
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(abortTimer);
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isPairResult(value: unknown): value is PairResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<PairResult>;
  return (
    typeof result.token === "string" &&
    result.token.length > 0 &&
    result.token.length <= MAX_TOKEN_CHARS &&
    Array.isArray(result.scopes) &&
    result.scopes.length <= MAX_SCOPE_COUNT &&
    result.scopes.every(
      (scope) => typeof scope === "string" && scope.length > 0 && scope.length <= MAX_SCOPE_CHARS,
    ) &&
    typeof result.device === "object" &&
    result.device !== null &&
    typeof result.device.id === "string" &&
    result.device.id.length > 0 &&
    result.device.id.length <= MAX_DEVICE_ID_CHARS &&
    typeof result.device.name === "string" &&
    result.device.name.length > 0 &&
    result.device.name.length <= MAX_DEVICE_NAME_CHARS &&
    typeof result.device.kind === "string" &&
    result.device.kind.length > 0 &&
    result.device.kind.length <= MAX_DEVICE_KIND_CHARS
  );
}

/**
 * The one scope a browser device is granted. Must equal the gateway's default
 * grant for the `browser` device kind (`defaultScopesForDeviceKind` in
 * `@omnesis/types`); `pairing.test.ts` pins the two together.
 */
export const REQUIRED_WEB_SCOPE = "write:web";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** A product version with an optional prerelease/build tail, bounded so a stray body cannot bloat the pairing record. */
const GATEWAY_VERSION_PATTERN = /^\d{1,4}\.\d{1,5}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,48})?$/u;

/**
 * Require the least-privileged browser token promised by the pairing flow.
 * Rejecting broader or different scopes prevents a mis-issued credential from
 * looking healthy while the document and analytics endpoints disagree.
 */
function assertWebScope(scopes: readonly string[] | undefined): void {
  const list = scopes ?? [];
  if (list.length === 1 && list[0] === REQUIRED_WEB_SCOPE) return;
  throw new GatewayUrlError(
    `This pairing code did not mint the expected least-privilege ${REQUIRED_WEB_SCOPE}-only token (got: ${
      list.length ? list.join(", ") : "none"
    }). Create a browser pairing code (omnesis devices pair --kind browser) and try again.`,
  );
}
