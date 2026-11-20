// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { gunzipSync } from "node:zlib";
import { createLogger } from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { DEFAULT_API_BASE, PLAUD_USER_AGENT, plaudApiBase } from "./hosts.js";
import {
  deviceListSchema,
  fileDetailSchema,
  fileListingSchema,
  fileSummarySchema,
  sendCodeResponseSchema,
  tempUrlSchema,
  tokenResponseSchema,
  workspaceListSchema,
  workspaceTokenSchema,
} from "./schemas.js";
import type { ZodType } from "zod";
import type { FileDetail, FileSummary } from "./schemas.js";

const log = createLogger("provider:plaud:client");

/** Regional redirects followed before giving up on a sign-in. */
const MAX_REGION_REDIRECTS = 3;
/** Recordings per listing request. */
const LISTING_PAGE_SIZE = 500;
/** Bound on listing requests, so a listing that never ends cannot loop forever. */
const MAX_LISTING_PAGES = 400;
/** Refresh the user token this long before Plaud says it expires. */
const REFRESH_MARGIN_S = 5 * 60;
/** Bound on a transcript or summary payload, compressed or not. */
const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
/** Plaud's own answer code for an account that lives on another regional host. */
const REGION_REDIRECT_STATUS = -302;

/** A Plaud user token, the refresh token that renews it, and when each ends (unix seconds). */
export interface PlaudTokens {
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt?: number;
  /** When the sign-in ends for good: a refresh never extends past it. */
  sessionExpiresAt?: number;
}

export interface PlaudHttpOptions {
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface PlaudClientOptions extends PlaudHttpOptions {
  /** Called with every renewed token set, so it outlives this client. */
  onTokens?: (tokens: PlaudTokens) => Promise<void>;
  /** Injectable clock, unix seconds. */
  nowSeconds?: () => number;
  /** Recordings per listing request. Injectable so tests can cross a page boundary. */
  listingPageSize?: number;
}

/** A recording's audio, or the reason there is none to transcribe. */
export type AudioDownload = { bytes: Uint8Array; mimeType: string } | { tooLarge: true };

/** Every recording Plaud lists, and whether the listing can vouch for what it omits. */
export interface PlaudListing {
  files: FileSummary[];
  /**
   * True when every page reported the same total and the listing named exactly
   * that many distinct recordings. A single recording added, removed or edited
   * while the pages were read shifts the pages under the reader and breaks one
   * of the two. Two changes can cancel out, so a caller that asserts absence
   * also compares two listings.
   */
  consistent: boolean;
  /** See {@link PlaudClient.listingScope}, as it stood when the listing finished. */
  scope: string;
}

/** A presigned link Plaud handed out has expired; asking Plaud again gets a fresh one. */
export class PlaudLinkExpiredError extends SyncError {
  constructor() {
    super("transient", "A Plaud download link expired before it was used");
    this.name = "PlaudLinkExpiredError";
  }
}

const SIGN_IN_ENDED =
  "Plaud ended this sign-in. Re-authenticate the source to sign in with a new code.";

function authEnded(message = SIGN_IN_ENDED): SyncError {
  return new SyncError("auth", message, { scope: "connection" });
}

/**
 * Start a sign-in: Plaud emails a one-time code to the address. Follows
 * Plaud's redirect to the account's regional host, and returns that host with
 * the token the code is redeemed against.
 */
export async function sendCode(
  email: string,
  opts: PlaudHttpOptions & { apiBase?: string } = {},
): Promise<{ otpToken: string; apiBase: string }> {
  let apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  for (let hop = 0; hop <= MAX_REGION_REDIRECTS; hop++) {
    const body = await postUnauthenticated(
      `${apiBase}/auth/otp-send-code`,
      { username: email },
      sendCodeResponseSchema,
      opts,
    );
    if (body.status === REGION_REDIRECT_STATUS) {
      const regional = body.data?.domains?.api ? plaudApiBase(body.data.domains.api) : undefined;
      if (!regional) {
        throw new SyncError(
          "unknown",
          "Plaud redirected the sign-in to a host that is not Plaud's",
        );
      }
      apiBase = regional;
      continue;
    }
    if (body.status !== 0 || !body.token) {
      throw new SyncError(
        "auth",
        `Plaud did not send a code to this address${body.msg ? `: ${body.msg}` : ""}`,
      );
    }
    return { otpToken: body.token, apiBase };
  }
  throw new SyncError("unknown", "Plaud redirected the sign-in too many times");
}

/** Redeem the emailed code for the account's tokens. */
export async function login(
  apiBase: string,
  code: string,
  otpToken: string,
  opts: PlaudHttpOptions = {},
): Promise<PlaudTokens> {
  const body = await postUnauthenticated(
    `${apiBase}/auth/otp-login`,
    { code, token: otpToken },
    tokenResponseSchema,
    opts,
  );
  const tokens = tokensFrom(body, undefined);
  if (!tokens || (body.status !== undefined && body.status !== null && body.status !== 0)) {
    throw new SyncError("auth", `Plaud did not accept the code${body.msg ? `: ${body.msg}` : ""}`);
  }
  return tokens;
}

/**
 * Renew the user token. Plaud keeps the refresh token valid after use and
 * never moves the end of the sign-in, so a refusal is the sign-in ending.
 */
export async function refreshTokens(
  apiBase: string,
  refreshToken: string,
  opts: PlaudHttpOptions & { signal?: AbortSignal } = {},
): Promise<PlaudTokens> {
  const res = await send(
    opts.fetchImpl ?? fetch,
    `${apiBase}/auth/refresh-user-token`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${refreshToken}`, "User-Agent": PLAUD_USER_AGENT },
      signal: opts.signal,
    },
    opts.signal,
  );
  if (res.status === 429) throw rateLimited(res);
  if (res.status >= 500) throw new SyncError("transient", `Plaud answered HTTP ${res.status}`);
  if (!res.ok) throw authEnded();
  const body = await parse(res, tokenResponseSchema);
  const tokens =
    body.status === undefined || body.status === null || body.status === 0
      ? tokensFrom(body, refreshToken)
      : undefined;
  if (!tokens) throw authEnded();
  return tokens;
}

/**
 * Plaud's web API for one signed-in account.
 *
 * Data requests carry a short-lived workspace token minted from the user
 * token, the way Plaud's web app does; it lives only in memory. The user token
 * is renewed shortly before it expires, and on a 401 the client first mints a
 * new workspace token, then renews the user token, and only then reports the
 * sign-in as ended (`auth`, scoped to the connection). Rate limits carry
 * Plaud's `Retry-After`; outages and network failures are transient.
 */
export class PlaudClient {
  private readonly fetchImpl: typeof fetch;
  private readonly onTokens?: (tokens: PlaudTokens) => Promise<void>;
  private readonly nowSeconds: () => number;
  private readonly listingPageSize: number;
  private workspaceToken: string | undefined;
  /** The workspace token could not be minted; data requests use the user token. */
  private workspaceUnavailable = false;
  private workspaceId: string | undefined;

  constructor(
    readonly apiBase: string,
    private tokens: PlaudTokens,
    opts: PlaudClientOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onTokens = opts.onTokens;
    this.nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.listingPageSize = opts.listingPageSize ?? LISTING_PAGE_SIZE;
  }

  /**
   * Whose recordings data requests read: the workspace a token was minted
   * for, or the user token's own view when none could be. A listing read
   * under another scope than the last may list a different set of recordings.
   */
  get listingScope(): string {
    return this.workspaceToken && this.workspaceId ? `workspace:${this.workspaceId}` : "user";
  }

  /** Every recording not in the trash, newest edit first. */
  async listFiles(signal?: AbortSignal): Promise<PlaudListing> {
    const files: FileSummary[] = [];
    const seen = new Set<string>();
    const totals = new Set<number | undefined>();
    let duplicates = false;
    for (let page = 0; page < MAX_LISTING_PAGES; page++) {
      const query = new URLSearchParams({
        skip: String(page * this.listingPageSize),
        limit: String(this.listingPageSize),
        is_trash: "0",
        sort_by: "edit_time",
        is_desc: "true",
      });
      const body = await this.request(`/file/simple/web?${query}`, fileListingSchema, { signal });
      if (body.status !== 0) {
        throw new SyncError(
          "unknown",
          `Plaud refused the recording listing (status ${body.status})`,
        );
      }
      totals.add(body.data_file_total ?? undefined);
      const entries = body.data_file_list ?? [];
      if (entries.length > this.listingPageSize) {
        throw new SyncError("unknown", "Plaud returned an invalid recording listing");
      }
      for (const entry of entries) {
        const parsed = fileSummarySchema.safeParse(entry);
        if (!parsed.success) {
          throw new SyncError("unknown", "Plaud returned an invalid recording listing");
        }
        if (parsed.data.is_trash) continue;
        if (seen.has(parsed.data.id)) {
          duplicates = true;
          continue;
        }
        seen.add(parsed.data.id);
        files.push(parsed.data);
      }
      if (entries.length < this.listingPageSize) {
        const [total] = [...totals];
        const consistent =
          !duplicates && totals.size === 1 && typeof total === "number" && total === seen.size;
        return { files, consistent, scope: this.listingScope };
      }
    }
    throw new SyncError("unknown", "Plaud's recording listing exceeded its safe page limit");
  }

  /** A recording's processed content: which transcript and summary exist, and where. */
  async getDetail(id: string, signal?: AbortSignal): Promise<FileDetail> {
    const body = await this.request(`/file/detail/${encodeURIComponent(id)}`, fileDetailSchema, {
      signal,
      item: true,
    });
    if (body.status !== 0 || !body.data) {
      throw new SyncError(
        "unknown",
        `Plaud could not serve recording ${id} (status ${body.status})`,
        {
          scope: "item",
        },
      );
    }
    return body.data;
  }

  /**
   * Download a recording's audio, preferring the compact Opus rendition. A
   * recording over `maxBytes` is not downloaded. An expired link is asked for
   * again once.
   */
  async downloadAudio(id: string, maxBytes: number, signal?: AbortSignal): Promise<AudioDownload> {
    for (let attempt = 0; ; attempt++) {
      const urls = await this.request(
        `/file/temp-url/${encodeURIComponent(id)}?is_opus=1`,
        tempUrlSchema,
        { signal, item: true },
      );
      const url = urls.temp_url_opus || urls.temp_url;
      if (!url) {
        throw new SyncError("unknown", `Plaud has no audio for recording ${id}`, { scope: "item" });
      }
      try {
        return await this.fetchPresigned(url, maxBytes, signal);
      } catch (err) {
        if (!(err instanceof PlaudLinkExpiredError)) throw err;
        if (attempt === 0) continue;
        // A fresh link refused as well: the audio itself is out of reach,
        // which is this recording's problem, not the account's.
        throw new SyncError("unknown", `Plaud refused the audio of recording ${id}`, {
          scope: "item",
        });
      }
    }
  }

  /**
   * Read a processed transcript or summary from its presigned link. Bodies may
   * be gzip-compressed; a body that is not JSON comes back as text.
   */
  async fetchContent(link: string, signal?: AbortSignal): Promise<unknown> {
    const download = await this.fetchPresigned(link, MAX_CONTENT_BYTES, signal);
    if ("tooLarge" in download) {
      throw new SyncError("unknown", "Plaud's transcript or summary is too large to read", {
        scope: "item",
      });
    }
    let bytes = download.bytes;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    const text = Buffer.from(bytes).toString("utf8");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  /** The account's recorders, by serial number. */
  async listDevices(signal?: AbortSignal): Promise<Map<string, string>> {
    const body = await this.request("/device/list", deviceListSchema, { signal });
    const out = new Map<string, string>();
    if (body.status !== 0) return out;
    for (const device of body.data_devices ?? []) {
      const label = device.name?.trim() || device.model?.trim();
      if (device.sn && label) out.set(device.sn, label);
    }
    return out;
  }

  private async request<T>(
    path: string,
    schema: ZodType<T>,
    opts: { signal?: AbortSignal; item?: boolean },
  ): Promise<T> {
    let workspaceReminted = false;
    let refreshed = false;
    for (;;) {
      const bearer = await this.bearer(opts.signal);
      const res = await send(
        this.fetchImpl,
        `${this.apiBase}${path}`,
        {
          headers: { Authorization: `Bearer ${bearer}`, "User-Agent": PLAUD_USER_AGENT },
          signal: opts.signal,
        },
        opts.signal,
      );
      if (res.status === 401) {
        await res.body?.cancel().catch(() => undefined);
        if (bearer === this.workspaceToken && !workspaceReminted) {
          workspaceReminted = true;
          this.workspaceToken = undefined;
          continue;
        }
        if (refreshed) throw authEnded();
        refreshed = true;
        await this.refresh(opts.signal);
        continue;
      }
      if (res.ok) return parse(res, schema);
      throw httpFailure(res, opts.item === true);
    }
  }

  /** The token a data request carries, renewing or minting what it needs first. */
  private async bearer(signal?: AbortSignal): Promise<string> {
    const now = this.nowSeconds();
    const { accessExpiresAt, sessionExpiresAt } = this.tokens;
    if (sessionExpiresAt !== undefined && now >= sessionExpiresAt) throw authEnded();
    if (accessExpiresAt !== undefined && now >= accessExpiresAt - REFRESH_MARGIN_S) {
      await this.refresh(signal);
    }
    if (!this.workspaceToken && !this.workspaceUnavailable) await this.mintWorkspaceToken(signal);
    return this.workspaceToken ?? this.tokens.accessToken;
  }

  private async refresh(signal?: AbortSignal): Promise<void> {
    const { refreshToken } = this.tokens;
    if (!refreshToken) throw authEnded();
    if (signal?.aborted) throw signal.reason;
    this.tokens = await refreshTokens(this.apiBase, refreshToken, {
      fetchImpl: this.fetchImpl,
      signal,
    });
    this.workspaceToken = undefined;
    this.workspaceUnavailable = false;
    try {
      await this.onTokens?.(this.tokens);
    } catch (err) {
      // The old refresh token stays valid, so the next run renews again.
      log.warn(`Could not store the renewed Plaud token: ${(err as Error).message}`);
    }
  }

  /**
   * Mint a workspace token for the account's personal workspace (or its first
   * one, for a team-only account). A failure other than the user token being
   * refused leaves data requests on the user token, as Plaud's web app does.
   */
  private async mintWorkspaceToken(signal?: AbortSignal): Promise<void> {
    const headers = {
      Authorization: `Bearer ${this.tokens.accessToken}`,
      "User-Agent": PLAUD_USER_AGENT,
      "Content-Type": "application/json",
    };
    try {
      const listRes = await send(
        this.fetchImpl,
        `${this.apiBase}/team-app/workspaces/list?need_personal_workspace=true`,
        { headers, signal },
        signal,
      );
      if (!listRes.ok) throw httpFailure(listRes, false);
      const list = await parse(listRes, workspaceListSchema);
      const workspaces = list.data?.workspaces ?? [];
      const chosen =
        workspaces.find((w) => String(w.workspace_type) === "0") ?? workspaces[0] ?? undefined;
      if (list.status !== 0 || !chosen) throw new SyncError("unknown", "No Plaud workspace");
      const mintRes = await send(
        this.fetchImpl,
        `${this.apiBase}/user-app/auth/workspace/token/${encodeURIComponent(chosen.workspace_id)}`,
        { method: "POST", headers, body: "{}", signal },
        signal,
      );
      if (!mintRes.ok) throw httpFailure(mintRes, false);
      const minted = await parse(mintRes, workspaceTokenSchema);
      const token = minted.status === 0 ? minted.data?.workspace_token : undefined;
      if (!token) throw new SyncError("unknown", "Plaud did not mint a workspace token");
      this.workspaceToken = token;
      this.workspaceId = chosen.workspace_id;
    } catch (err) {
      if (signal?.aborted) throw err;
      // A refused user token is handled by the data request's own 401 path.
      if (err instanceof SyncError && (err.kind === "rate-limit" || err.kind === "network")) {
        throw err;
      }
      log.warn(
        `Plaud workspace token unavailable, using the user token: ${(err as Error).message}`,
      );
      this.workspaceUnavailable = true;
    }
  }

  private async fetchPresigned(
    url: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<AudioDownload> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new SyncError("unknown", "Plaud returned an invalid download link", { scope: "item" });
    }
    if (parsed.protocol !== "https:") {
      throw new SyncError("unknown", "Plaud returned a download link that is not https", {
        scope: "item",
      });
    }
    // Presigned: the link carries its own authorization, so no token is sent.
    const res = await send(this.fetchImpl, url, { signal }, signal);
    if (res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      throw new PlaudLinkExpiredError();
    }
    if (!res.ok) throw httpFailure(res, true);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    const bytes = await readCapped(res, maxBytes);
    if (!bytes) return { tooLarge: true };
    return { bytes, mimeType: audioMimeType(parsed.pathname, res.headers.get("content-type")) };
  }
}

/** The media type of a downloaded recording, from its file name first. */
export function audioMimeType(pathname: string, contentType: string | null): string {
  const ext = /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase();
  switch (ext) {
    case "opus":
    case "ogg":
      return "audio/ogg";
    case "mp3":
      return "audio/mpeg";
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "wav":
      return "audio/wav";
  }
  const declared = contentType?.split(";")[0]?.trim().toLowerCase();
  return declared?.startsWith("audio/") ? declared : "audio/mpeg";
}

/** Read a body, giving up (and returning null) once it passes `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function tokensFrom(
  body: {
    access_token?: string | null;
    refresh_token?: string | null;
    ut_expire_at?: number | null;
    urt_expire_at?: number | null;
    data?: {
      access_token?: string | null;
      refresh_token?: string | null;
      ut_expire_at?: number | null;
      urt_expire_at?: number | null;
    } | null;
  },
  fallbackRefreshToken: string | undefined,
): PlaudTokens | undefined {
  const accessToken = body.access_token ?? body.data?.access_token;
  if (!accessToken) return undefined;
  const refreshToken = body.refresh_token ?? body.data?.refresh_token ?? fallbackRefreshToken;
  const accessExpiresAt = positive(body.ut_expire_at ?? body.data?.ut_expire_at);
  const sessionExpiresAt = positive(body.urt_expire_at ?? body.data?.urt_expire_at);
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(accessExpiresAt !== undefined ? { accessExpiresAt } : {}),
    // Without a refresh token the sign-in ends with the access token.
    ...(refreshToken
      ? sessionExpiresAt !== undefined
        ? { sessionExpiresAt }
        : {}
      : accessExpiresAt !== undefined
        ? { sessionExpiresAt: accessExpiresAt }
        : {}),
  };
}

function positive(v: number | null | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

async function postUnauthenticated<T>(
  url: string,
  body: unknown,
  schema: ZodType<T>,
  opts: PlaudHttpOptions,
): Promise<T> {
  const res = await send(opts.fetchImpl ?? fetch, url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": PLAUD_USER_AGENT },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw httpFailure(res, false);
  return parse(res, schema);
}

async function send(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new SyncError("network", `Could not reach Plaud: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

async function parse<T>(res: Response, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new SyncError("unknown", "Plaud did not answer with JSON", { cause: err });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 3)
      .map((i) => i.path.join(".") || "<root>")
      .join(", ");
    throw new SyncError("unknown", `Plaud answered in an unexpected shape (${where})`);
  }
  return parsed.data;
}

function rateLimited(res: Response): SyncError {
  const seconds = Number(res.headers.get("retry-after"));
  return new SyncError("rate-limit", "Plaud is rate limiting requests", {
    ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: seconds * 1000 } : {}),
  });
}

/** A failed answer, classified. `item` scopes a 404 or refusal to the one recording. */
function httpFailure(res: Response, item: boolean): SyncError {
  void res.body?.cancel().catch(() => undefined);
  if (res.status === 429) return rateLimited(res);
  if (res.status === 401) return authEnded();
  if (res.status >= 500) return new SyncError("transient", `Plaud answered HTTP ${res.status}`);
  if (res.status === 404 && item) {
    return new SyncError("unknown", "Plaud no longer has this recording (HTTP 404)", {
      scope: "item",
    });
  }
  if (res.status === 403) {
    // On one recording's endpoint it is that recording (shared, or no longer
    // the account's); anywhere else it is the account.
    return new SyncError(
      "permission",
      "Plaud refused the request (HTTP 403)",
      item ? { scope: "item" } : {},
    );
  }
  return new SyncError(
    "unknown",
    `Plaud answered HTTP ${res.status}`,
    item ? { scope: "item" } : {},
  );
}
