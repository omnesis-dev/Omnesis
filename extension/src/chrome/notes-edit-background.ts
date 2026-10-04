// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { NotesEditService, NOTES_EDIT_STATE_KEY, NOTES_PAGE_KEY } from "./notes-edit-service.js";
import { NOTES_EDIT_TOKEN_KEY } from "./notes-edit-credential.js";
import { FIND_TOKEN_KEY } from "./find-credential.js";
import { loadConfig } from "./storage.js";

export function installNotesEditBackground(ensureRead: () => Promise<unknown>) {
  const service = new NotesEditService({
    config: loadConfig,
    ensureRead,
    fetch: (input, init) => fetch(input, init),
    read: async () => {
      const stored = await chrome.storage.local.get([NOTES_EDIT_STATE_KEY, NOTES_EDIT_TOKEN_KEY]);
      const state = stored[NOTES_EDIT_STATE_KEY] as { pairing?: string } | null;
      const credential = stored[NOTES_EDIT_TOKEN_KEY] as {
        pairing?: string;
        token?: string;
      } | null;
      return state
        ? {
            ...state,
            ...(credential?.pairing === state.pairing && typeof credential?.token === "string"
              ? { token: credential.token }
              : {}),
          }
        : null;
    },
    write: async (state) => {
      const { token, ...publicState } = state ?? {};
      await chrome.storage.local.set({
        [NOTES_EDIT_STATE_KEY]: state ? publicState : null,
        [NOTES_EDIT_TOKEN_KEY]: token ? { pairing: state?.pairing, token } : null,
      });
    },
    readToken: async (config) => {
      const stored = await chrome.storage.local.get(FIND_TOKEN_KEY);
      const credential = stored[FIND_TOKEN_KEY] as { pairing?: string; token?: string } | null;
      return credential?.pairing === `${config.gatewayUrl}\0${config.deviceId}` &&
        typeof credential.token === "string"
        ? credential.token
        : null;
    },
  });
  return {
    clear: async () => {
      await service.clear();
      await chrome.storage.local.set({ [NOTES_PAGE_KEY]: null });
    },
    message(
      message: unknown,
      sender: chrome.runtime.MessageSender,
      respond: (value?: unknown) => void,
    ): boolean {
      if (
        sender.id !== chrome.runtime.id ||
        sender.url !== chrome.runtime.getURL("notes.html") ||
        !message ||
        typeof message !== "object"
      )
        return false;
      const msg = message as { type?: unknown; id?: unknown; url?: unknown; text?: unknown };
      let task: Promise<unknown>;
      if (msg.type === "notes-edit-list" && typeof msg.url === "string")
        task = service.list(msg.url);
      else if (
        msg.type === "notes-edit-select" &&
        typeof msg.id === "string" &&
        msg.id.length <= 128 &&
        typeof msg.url === "string"
      )
        task = service.select(msg.id, msg.url);
      else if (
        msg.type === "notes-edit-update" &&
        typeof msg.text === "string" &&
        msg.text.length <= 8192
      )
        task = service.update(msg.text);
      else if (msg.type === "notes-edit-save") task = service.save();
      else if (msg.type === "notes-edit-discard") task = service.discard();
      else return false;
      void task.then(respond, (error: unknown) =>
        respond({
          ok: false,
          reason:
            error instanceof Error
              ? error.message
              : "Saved notes are unavailable. Your edit is kept.",
        }),
      );
      return true;
    },
  };
}
