// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeUrl } from "@omnesis/core";
import { BadRequestError, ForbiddenError, HttpError, NotFoundError } from "../errors.js";
import {
  browserNoteRevision,
  browserNoteUserText,
  publicBrowserNoteEntry,
} from "../../sources/omnesis-notes/browser-note.js";
import { BrowserAuthorizationService } from "./BrowserAuthorizationService.js";
import type { AuthContext } from "../routes/types.js";
import type { OmnesisNotesRuntime, NoteEntry } from "../../sources/omnesis-notes/index.js";

/** Page-associated ledger notes; ordinary corpus documents cannot be changed here. */
export class BrowserNotesEditService extends BrowserAuthorizationService {
  constructor(
    private readonly editDeps: ConstructorParameters<typeof BrowserAuthorizationService>[0] & {
      runtime: () => OmnesisNotesRuntime;
    },
  ) {
    super(editDeps);
  }

  private pageUrl(raw: string): string {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    return normalizeUrl(url.href);
  }
  private result(entry: NoteEntry, documentId: string | null) {
    return {
      id: entry.id,
      documentId,
      text: browserNoteUserText(entry),
      revision: browserNoteRevision(entry),
      capturedAt: entry.capturedAt,
      updatedAt: entry.updatedAt,
      page: publicBrowserNoteEntry(entry).page ?? null,
      editable: true,
    };
  }
  list(auth: AuthContext, rawUrl: string) {
    const browser = this.browser(auth, "read");
    const entries = this.editDeps.runtime().listBrowser(browser.deviceId, this.pageUrl(rawUrl));
    this.browser(auth, "read");
    return { notes: entries.map(({ entry, documentId }) => this.result(entry, documentId)) };
  }
  async edit(
    auth: AuthContext,
    id: string,
    input: { url: string; text: string; revision: string },
  ) {
    const authority = this.browser(auth, "notes:update");
    const result = await this.editDeps
      .runtime()
      .editBrowser({
        id,
        url: this.pageUrl(input.url),
        text: input.text,
        revision: input.revision,
        authority,
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "BrowserNotesUnavailableError")
          throw new NotFoundError("Browser notes feature is unavailable");
        if (error instanceof Error && error.name === "BrowserNoteAuthorizationError")
          throw new ForbiddenError("Browser note permission is no longer active");
        if (error instanceof Error && error.message === "BrowserNoteTextTooLong")
          throw new BadRequestError("Note and page context must fit within 8192 characters");
        throw error;
      });
    this.browser(auth, "notes:update");
    if (result.outcome === "missing") throw new NotFoundError("Associated note not found");
    if (result.outcome === "conflict")
      throw new HttpError(
        409,
        "NOTE_EDIT_CONFLICT",
        "This note changed or is no longer attached to this page. Reload it before editing.",
      );
    return this.result(result.entry, result.documentId);
  }
}
