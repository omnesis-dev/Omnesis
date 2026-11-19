// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * An in-memory Plaud web API for tests: sign-in with regional redirects,
 * token refresh, workspace tokens, the recording listing, details, content
 * and audio behind presigned links. Every value in it is invented.
 */

import { gzipSync } from "node:zlib";

export const FAKE_EMAIL = "maya.reeves@example.com";
export const GLOBAL_BASE = "https://api.plaud.ai";
export const EU_BASE = "https://api-euc1.plaud.ai";
const STORAGE = "https://storage.example.com";

export interface FakeRecording {
  id: string;
  filename: string;
  start_time: number;
  duration: number;
  version_ms: number;
  serial_number?: string;
  keywords?: string[];
  is_trans: boolean;
  is_summary: boolean;
  /** Plaud's transcript segments, served gzipped behind a link. */
  transcript?: unknown;
  /** Plaud's summary, served inline. */
  summary?: unknown;
  audio?: Uint8Array<ArrayBuffer>;
}

export class FakePlaud {
  readonly recordings = new Map<string, FakeRecording>();
  /** Every request served, as `METHOD host/path?query`. */
  readonly requests: string[] = [];
  /** The regional host the account lives on; sign-in starting elsewhere is redirected. */
  home = EU_BASE;
  code = "246810";
  accessToken = "ut-1";
  refreshToken = "rt-1";
  /** Unix seconds; refresh answers with this as the new access expiry. */
  accessExpiresAt = 2_000_000_000;
  sessionExpiresAt = 2_100_000_000;
  /** Refresh refuses (the sign-in ended). */
  refreshRefused = false;
  workspaceToken = "wt-1";
  /** Mint refuses with this HTTP status. */
  mintFailure: number | undefined;
  /** Workspace tokens Plaud no longer honours. */
  readonly revokedWorkspaceTokens = new Set<string>();
  /** User tokens Plaud no longer honours. */
  readonly revokedAccessTokens = new Set<string>();
  /** Answer the next request whose path includes `match` with this instead. */
  failNext: { match: string; status: number; headers?: Record<string, string> } | undefined;
  /** Presigned links that have expired. */
  readonly expiredLinks = new Set<string>();
  /** Expire every link the next time it is handed out, once. */
  expireNextLinks = 0;
  /** Report a total different from what the listing holds, as when it moves while read. */
  totalSkew = 0;
  /** Called as each listing starts (its first page), with how many started before it. */
  onListing: ((started: number) => void) | undefined;
  private listings = 0;
  private refreshes = 0;
  private minted = 0;
  private linkSerial = 0;

  addRecording(r: Partial<FakeRecording> & { id: string }): FakeRecording {
    const n = this.recordings.size + 1;
    const full: FakeRecording = {
      filename: `Recording ${r.id}`,
      start_time: Date.UTC(2026, 9, 1, 9, 0, 0) + n * 3_600_000,
      duration: 125_000,
      version_ms: Date.UTC(2026, 9, 1, 12, 0, 0) + n * 1000,
      is_trans: false,
      is_summary: false,
      ...r,
    };
    this.recordings.set(full.id, full);
    return full;
  }

  /** Bump a recording's version, as an edit in the Plaud app does. */
  edit(id: string, change: Partial<FakeRecording>): void {
    const r = this.recordings.get(id)!;
    Object.assign(r, change, { version_ms: r.version_ms + 60_000 });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    this.requests.push(`${method} ${url.host}${url.pathname}${url.search}`);
    const path = url.pathname;
    if (this.failNext && `${url.host}${path}`.includes(this.failNext.match)) {
      const { status, headers } = this.failNext;
      this.failNext = undefined;
      return new Response("{}", { status, headers });
    }
    if (url.origin === STORAGE) return this.storage(url);
    const auth = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (path === "/auth/otp-send-code") {
      if (url.origin !== this.home) {
        return json({ status: -302, msg: "region", data: { domains: { api: this.home } } });
      }
      return body.username === FAKE_EMAIL
        ? json({ status: 0, msg: "ok", token: "otp-token" })
        : json({ status: -1, msg: "user not found" });
    }
    if (path === "/auth/otp-login") {
      if (body.code !== this.code || body.token !== "otp-token") {
        return json({ status: -1, msg: "invalid code" });
      }
      return json({
        status: 0,
        data: {
          access_token: this.accessToken,
          refresh_token: this.refreshToken,
          ut_expire_at: this.accessExpiresAt,
          urt_expire_at: this.sessionExpiresAt,
        },
      });
    }
    if (path === "/auth/refresh-user-token") {
      if (this.refreshRefused || auth !== this.refreshToken) return json({ status: -1 }, 401);
      this.refreshes += 1;
      this.accessToken = `ut-${this.refreshes + 1}`;
      return json({
        status: 0,
        access_token: this.accessToken,
        ut_expire_at: this.accessExpiresAt,
        urt_expire_at: this.sessionExpiresAt,
      });
    }

    if (!auth || this.revokedAccessTokens.has(auth) || this.revokedWorkspaceTokens.has(auth)) {
      return json({ status: -1, msg: "unauthorized" }, 401);
    }
    if (path === "/team-app/workspaces/list") {
      if (auth !== this.accessToken) return json({}, 401);
      return json({
        status: 0,
        data: {
          workspaces: [
            { workspace_id: "team-1", workspace_type: "1" },
            { workspace_id: "personal-1", workspace_type: "0" },
          ],
        },
      });
    }
    if (path.startsWith("/user-app/auth/workspace/token/")) {
      if (auth !== this.accessToken) return json({}, 401);
      if (this.mintFailure) return json({}, this.mintFailure);
      this.minted += 1;
      this.workspaceToken = `wt-${this.minted}`;
      return json({ status: 0, data: { workspace_token: this.workspaceToken } });
    }
    // Data endpoints take the current workspace token, or the user token.
    if (auth !== this.workspaceToken && auth !== this.accessToken) return json({}, 401);

    if (path === "/file/simple/web") {
      const skip = Number(url.searchParams.get("skip"));
      if (skip === 0) this.onListing?.(this.listings++);
      const limit = Number(url.searchParams.get("limit"));
      const all = [...this.recordings.values()].sort((a, b) => b.version_ms - a.version_ms);
      return json({
        status: 0,
        data_file_total: all.length + this.totalSkew,
        data_file_list: all.slice(skip, skip + limit).map((r) => ({
          id: r.id,
          filename: r.filename,
          filesize: r.audio?.length ?? 1000,
          start_time: r.start_time,
          end_time: r.start_time + r.duration,
          duration: r.duration,
          edit_time: Math.floor(r.version_ms / 1000),
          version_ms: r.version_ms,
          serial_number: r.serial_number ?? "",
          keywords: r.keywords ?? [],
          filetag_id_list: [],
          is_trash: false,
          is_trans: r.is_trans,
          is_summary: r.is_summary,
        })),
      });
    }
    if (path === "/device/list") {
      return json({
        status: 0,
        data_devices: [{ sn: "SN-0001", name: "Desk recorder", model: "note" }],
      });
    }
    const detail = /^\/file\/detail\/(.+)$/.exec(path);
    if (detail) {
      const r = this.recordings.get(decodeURIComponent(detail[1]!));
      if (!r) return json({ status: -1, msg: "not found" }, 404);
      const content_list = [];
      const pre_download_content_list = [];
      if (r.is_trans && r.transcript !== undefined) {
        content_list.push({
          data_id: `source_transaction:${r.id}`,
          data_type: "transaction",
          task_status: 1,
          data_link: this.link(`transcript/${r.id}`),
        });
      }
      if (r.is_summary && r.summary !== undefined) {
        content_list.push({
          data_id: `auto_sum:${r.id}`,
          data_type: "auto_sum_note",
          task_status: 1,
          data_link: this.link(`summary/${r.id}`),
        });
        pre_download_content_list.push({
          data_id: `auto_sum:${r.id}`,
          data_content: JSON.stringify(r.summary),
        });
      }
      return json({ status: 0, data: { file_id: r.id, content_list, pre_download_content_list } });
    }
    const temp = /^\/file\/temp-url\/(.+)$/.exec(path);
    if (temp) {
      const r = this.recordings.get(decodeURIComponent(temp[1]!));
      if (!r) return json({ status: -1 }, 404);
      return json({
        status: 0,
        temp_url: this.link(`audio/${r.id}.mp3`),
        temp_url_opus: this.link(`audio/${r.id}.opus`),
      });
    }
    return json({ status: -1, msg: "no such endpoint" }, 404);
  };

  private link(path: string): string {
    this.linkSerial += 1;
    const url = `${STORAGE}/${path}?sig=${this.linkSerial}`;
    if (this.expireNextLinks > 0) {
      this.expireNextLinks -= 1;
      this.expiredLinks.add(url);
    }
    return url;
  }

  private storage(url: URL): Response {
    if (this.expiredLinks.has(url.toString())) return new Response("expired", { status: 403 });
    const [kind, file] = url.pathname.slice(1).split("/");
    const id = file!.replace(/\.(opus|mp3)$/, "");
    const r = this.recordings.get(id);
    if (!r) return new Response("missing", { status: 404 });
    if (kind === "transcript") {
      return new Response(gzipSync(Buffer.from(JSON.stringify(r.transcript))));
    }
    if (kind === "summary") return json(r.summary);
    const audio = r.audio ?? new Uint8Array([1, 2, 3, 4]);
    return new Response(audio, { headers: { "content-length": String(audio.length) } });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
