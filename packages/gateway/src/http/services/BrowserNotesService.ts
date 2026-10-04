// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeUrl } from "@omnesis/core";
import { Scope, type DeviceId, type TokenId } from "@omnesis/types";
import { BadRequestError, ForbiddenError, NotFoundError, HttpError } from "../errors.js";
import type { AuthContext } from "../routes/types.js";
import type { DeviceService } from "./DeviceService.js";
import type { WriteGate } from "../../write-gate.js";
import type { CaptureNoteInput, OmnesisNotesRuntime } from "../../sources/omnesis-notes/index.js";
import type { NotePageContext } from "../../sources/omnesis-notes/storage.js";

const CREATE_SCOPE = Scope("notes:create");
const REQUEST_TTL_MS = 10 * 60_000;
const MAX_PENDING_REQUESTS = 256;
interface Credential {
  token: string;
  tokenId: TokenId;
  scopes: string[];
  deviceId: DeviceId;
}
interface Authorization {
  requestId: string;
  deviceId: DeviceId;
  tokenId: TokenId;
  expiresAt: number;
  credential?: Credential;
  approving?: Promise<void>;
}

/** Optional device-bound authority, approved through the gateway owner's portal session. */
export class BrowserNotesService {
  private readonly authorizations = new Map<string, Authorization>();
  constructor(
    private readonly deps: {
      devices: DeviceService;
      writeGate: Pick<WriteGate, "createToken" | "revokeToken">;
      runtime: () => OmnesisNotesRuntime;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private browser(auth: AuthContext, required: string): { deviceId: DeviceId; tokenId: TokenId } {
    if (
      auth.authMethod !== "bearer" ||
      !auth.deviceId ||
      !auth.tokenId ||
      !auth.scopes.includes(Scope(required))
    ) {
      throw new ForbiddenError(`Forbidden: browser ${required} credential required`);
    }
    const device = this.deps.devices.getById(auth.deviceId);
    if (!device || device.kind !== "browser" || device.revokedAt !== null) {
      throw new ForbiddenError("Forbidden: active browser device required");
    }
    return { deviceId: auth.deviceId, tokenId: auth.tokenId };
  }
  private active(request: Authorization): boolean {
    const device = this.deps.devices.getById(request.deviceId);
    return (
      !!device &&
      device.revokedAt === null &&
      this.deps.devices.tokenIsActive(request.tokenId, request.deviceId)
    );
  }
  private request(id: string): Authorization {
    const request = this.authorizations.get(id);
    if (!request || request.expiresAt <= this.now()) {
      this.authorizations.delete(id);
      throw new NotFoundError("Authorization expired; enable Tell Omnesis again in the extension");
    }
    if (!this.active(request))
      throw new ForbiddenError("Browser authorization is no longer active");
    return request;
  }
  createAuthorization(auth: AuthContext, id: string) {
    const browser = this.browser(auth, "write:web");
    for (const [key, request] of this.authorizations)
      if (request.expiresAt <= this.now()) this.authorizations.delete(key);
    for (const [key, request] of this.authorizations) {
      if (
        request.tokenId === browser.tokenId &&
        request.credential &&
        !this.deps.devices
          .listTokens(request.deviceId)
          .some((token) => token.id === request.credential!.tokenId)
      )
        this.authorizations.delete(key);
    }
    const existing = this.authorizations.get(id);
    if (
      existing &&
      (existing.deviceId !== browser.deviceId || existing.tokenId !== browser.tokenId)
    )
      throw new NotFoundError("Authorization not found");
    if (!existing && this.authorizations.size >= MAX_PENDING_REQUESTS)
      throw new HttpError(429, "AUTHORIZATION_LIMIT", "Too many pending authorizations");
    // One outstanding request per credential prevents a paired client from filling the pending queue.
    const sameBrowser = [...this.authorizations.values()].find(
      (request) => request.tokenId === browser.tokenId,
    );
    const request = existing ??
      sameBrowser ?? { requestId: id, ...browser, expiresAt: this.now() + REQUEST_TTL_MS };
    this.authorizations.set(request.requestId, request);
    if (!existing && !sameBrowser) {
      const expiration = setTimeout(() => {
        if (this.authorizations.get(request.requestId) === request)
          this.authorizations.delete(request.requestId);
      }, REQUEST_TTL_MS);
      expiration.unref();
    }
    return {
      requestId: request.requestId,
      expiresAt: request.expiresAt,
      approvalPath: `/portal/browser-notes?request=${encodeURIComponent(request.requestId)}`,
    };
  }
  private requireUnrevokedCredential(request: Authorization): void {
    if (
      request.credential &&
      !this.deps.devices.tokenIsActive(request.credential.tokenId, request.deviceId)
    ) {
      throw new NotFoundError(
        "Notes permission was revoked; enable Tell Omnesis again in the extension",
      );
    }
  }
  authorization(id: string) {
    const request = this.request(id);
    this.requireUnrevokedCredential(request);
    return {
      requestId: id,
      deviceName: this.deps.devices.getById(request.deviceId)!.name,
      expiresAt: request.expiresAt,
      status: request.credential ? "approved" : "pending",
    };
  }
  async approve(id: string): Promise<void> {
    const request = this.request(id);
    if (request.credential) {
      this.requireUnrevokedCredential(request);
      return;
    }
    if (!request.approving) {
      request.approving = (async () => {
        const minted = await this.deps.writeGate.createToken(
          request.deviceId,
          [CREATE_SCOPE],
          "Browser Tell Omnesis",
        );
        if (!this.active(request) || request.expiresAt <= this.now()) {
          await this.deps.writeGate.revokeToken(minted.id);
          throw new ForbiddenError("Browser authorization is no longer active");
        }
        request.credential = {
          token: minted.token,
          tokenId: minted.id,
          scopes: [CREATE_SCOPE],
          deviceId: request.deviceId,
        };
      })();
    }
    try {
      await request.approving;
    } finally {
      request.approving = undefined;
    }
  }
  poll(auth: AuthContext, id: string) {
    const browser = this.browser(auth, "write:web");
    const request = this.request(id);
    if (request.deviceId !== browser.deviceId || request.tokenId !== browser.tokenId)
      throw new NotFoundError("Authorization not found");
    if (!request.credential) return { status: "pending" };
    if (
      !this.deps.devices
        .listTokens(request.deviceId)
        .some((token) => token.id === request.credential!.tokenId)
    )
      return { status: "revoked" };
    return { status: "approved", credential: request.credential };
  }
  status(auth: AuthContext) {
    this.browser(auth, "notes:create");
    return { enabled: true };
  }
  async capture(
    auth: AuthContext,
    input: CaptureNoteInput & { id: string; page: NotePageContext },
  ) {
    const browser = this.browser(auth, "notes:create");
    const url = new URL(input.page.url);
    url.username = "";
    url.password = "";
    const page = { ...input.page, url: normalizeUrl(url.href) };
    const quote = page.selection
      ? `\n\nSelected passage:\n${page.selection
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}`
      : "";
    const title = page.title?.replace(/\s+/g, " ").trim();
    const text = `${input.text.trim()}\n\nPage: ${title ? `${title} — ` : ""}${page.url}${quote}`;
    if (text.length > 8192)
      throw new BadRequestError("Note, page context and quotation must fit within 8192 characters");
    const entry = await this.deps
      .runtime()
      .capture({
        ...input,
        page,
        browserAuthority: browser,
        text,
        surface: "chrome-extension",
        deviceId: browser.deviceId,
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "BrowserNoteAuthorizationError")
          throw new ForbiddenError("Browser note permission is no longer active");
        throw error;
      });
    if (entry.deviceId !== browser.deviceId)
      throw new ForbiddenError("Note id belongs to another capture");
    if (
      entry.text !== text ||
      entry.page?.url !== page.url ||
      entry.page?.title !== page.title ||
      entry.page?.selection !== page.selection
    )
      throw new HttpError(409, "NOTE_ID_CONFLICT", "Note id already used with different content");
    return entry;
  }
}
