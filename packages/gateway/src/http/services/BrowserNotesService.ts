// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeUrl } from "@omnesis/core";
import { BadRequestError, ForbiddenError, HttpError, NotFoundError } from "../errors.js";
import { BrowserAuthorizationService } from "./BrowserAuthorizationService.js";
import type { AuthContext } from "../routes/types.js";
import type { DeviceService } from "./DeviceService.js";
import type { WriteGate } from "../../write-gate.js";
import type { CaptureNoteInput, OmnesisNotesRuntime } from "../../sources/omnesis-notes/index.js";
import type { NotePageContext } from "../../sources/omnesis-notes/storage.js";

/** Creates browser notes using separately approved device-bound authority. */
export class BrowserNotesService {
  private readonly authorizationService: BrowserAuthorizationService;
  constructor(
    private readonly deps: {
      devices: DeviceService;
      writeGate: Pick<WriteGate, "createToken" | "revokeToken">;
      runtime: () => OmnesisNotesRuntime;
      now?: () => number;
    },
  ) {
    this.authorizationService = new BrowserAuthorizationService({
      ...deps,
      scope: "notes:create",
      label: "Browser Tell Omnesis",
      feature: "browser-notes",
    });
  }
  createAuthorization(auth: AuthContext, id: string) {
    return this.authorizationService.createAuthorization(auth, id);
  }
  authorization(id: string) {
    return this.authorizationService.authorization(id);
  }
  approve(id: string) {
    return this.authorizationService.approve(id);
  }
  poll(auth: AuthContext, id: string) {
    return this.authorizationService.poll(auth, id);
  }
  status(auth: AuthContext) {
    return this.authorizationService.status(auth);
  }
  async capture(
    auth: AuthContext,
    input: CaptureNoteInput & { id: string; page: NotePageContext },
  ) {
    const browser = this.authorizationService.browser(auth, "notes:create");
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
        if (error instanceof Error && error.name === "BrowserNotesUnavailableError")
          throw new NotFoundError("Browser notes feature is unavailable");
        if (error instanceof Error && error.name === "BrowserNoteAuthorizationError")
          throw new ForbiddenError("Browser note permission is no longer active");
        throw error;
      });
    // The runtime can await a queued write or return an idempotent existing entry.
    this.authorizationService.browser(auth, "notes:create");
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
