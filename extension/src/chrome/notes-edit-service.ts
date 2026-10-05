// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readBoundedResponseText } from "../push/response-body.js";
import type { ExtensionConfig } from "./storage.js";

export const NOTES_EDIT_STATE_KEY = "omnesis.notes.edit.state.v1";
export const NOTES_PAGE_KEY = "omnesis.notes.page.v1";
export interface SavedBrowserNote {
  id: string;
  documentId: string | null;
  text: string;
  revision: string;
  page: { url: string; title?: string; selection?: string } | null;
  editable: boolean;
  capturedAt: string;
  updatedAt: string;
}
interface EditDraft {
  id: string;
  url: string;
  revision: string;
  text: string;
  original: string;
}
interface EditState {
  pairing: string;
  token?: string;
  grantId?: string;
  url: string;
  enabled: boolean;
  notes: SavedBrowserNote[];
  draft?: EditDraft;
  error?: string;
}
export interface NotesEditView {
  enabled: boolean;
  url: string;
  notes: SavedBrowserNote[];
  draft?: EditDraft;
  error?: string;
}
interface EditDeps {
  config(): Promise<ExtensionConfig | null>;
  read(): Promise<unknown>;
  write(state: EditState | null): Promise<void>;
  readToken(config: ExtensionConfig): Promise<string | null>;
  ensureRead(): Promise<unknown>;
  fetch: typeof fetch;
}
const identity = (config: ExtensionConfig): string => `${config.gatewayUrl}\0${config.deviceId}`;
function pageUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function note(raw: unknown): SavedBrowserNote | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as SavedBrowserNote;
  if (
    typeof value.id !== "string" ||
    value.id.length > 128 ||
    typeof value.text !== "string" ||
    value.text.length > 8192 ||
    typeof value.revision !== "string" ||
    !/^[a-f0-9]{64}$/i.test(value.revision) ||
    typeof value.capturedAt !== "string" ||
    typeof value.updatedAt !== "string"
  )
    return null;
  return {
    id: value.id,
    documentId: typeof value.documentId === "string" ? value.documentId : null,
    text: value.text,
    revision: value.revision,
    capturedAt: value.capturedAt,
    updatedAt: value.updatedAt,
    editable: value.editable === true,
    page:
      value.page && pageUrl(value.page.url)
        ? {
            url: value.page.url,
            ...(typeof value.page.title === "string"
              ? { title: value.page.title.slice(0, 512) }
              : {}),
          }
        : null,
  };
}
function range(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const { min, max } = value as { min?: unknown; max?: unknown };
  return (
    typeof min === "number" &&
    typeof max === "number" &&
    Number.isInteger(min) &&
    Number.isInteger(max) &&
    min > 0 &&
    min <= max &&
    min <= 1 &&
    max >= 1
  );
}
class EditHttpError extends Error {
  constructor(readonly status: number) {
    super(
      status === 409
        ? "This note changed. Your edit is kept. Copy it if needed, then discard changes and reopen this note to load the latest version."
        : `Gateway returned HTTP ${status}`,
    );
  }
}
/** Independent update authority; edits never flow through the creation outbox. */
export class NotesEditService {
  private lane: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: EditDeps) {}
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.lane.then(task, task);
    this.lane = next.catch(() => undefined);
    return next;
  }
  private async load() {
    const config = await this.deps.config();
    if (!config) return null;
    const raw = (await this.deps.read()) as Partial<EditState> | null;
    const state: EditState =
      raw?.pairing === identity(config)
        ? {
            pairing: identity(config),
            url: pageUrl(raw.url) ?? "",
            enabled: raw.enabled === true,
            notes: Array.isArray(raw.notes)
              ? raw.notes.slice(0, 100).flatMap((value) => {
                  const entry = note(value);
                  return entry ? [entry] : [];
                })
              : [],
            ...(typeof raw.token === "string" ? { token: raw.token } : {}),
            ...(typeof raw.grantId === "string" ? { grantId: raw.grantId } : {}),
            ...(raw.draft &&
            typeof raw.draft.id === "string" &&
            pageUrl(raw.draft.url) &&
            typeof raw.draft.text === "string" &&
            raw.draft.text.length <= 8192 &&
            typeof raw.draft.original === "string" &&
            raw.draft.original.length <= 8192 &&
            /^[a-f0-9]{64}$/i.test(raw.draft.revision)
              ? { draft: raw.draft }
              : {}),
            ...(typeof raw.error === "string" ? { error: raw.error } : {}),
          }
        : { pairing: identity(config), url: "", enabled: false, notes: [] };
    return { config, state };
  }
  private async persist(config: ExtensionConfig, state: EditState): Promise<void> {
    const current = await this.deps.config();
    if (!current || identity(current) !== identity(config) || current.token !== config.token)
      throw new Error("Browser pairing changed. Your edit was not sent.");
    await this.deps.write(state);
  }
  private view(state?: EditState): NotesEditView {
    return {
      enabled: state?.enabled ?? false,
      url: state?.url ?? "",
      notes: state?.enabled ? state.notes : [],
      ...(state?.enabled && state.draft ? { draft: state.draft } : {}),
      ...(state?.error ? { error: state.error } : {}),
    };
  }
  private async request(
    config: ExtensionConfig,
    path: string,
    token?: string,
    body?: unknown,
    method?: string,
  ): Promise<unknown> {
    const response = await this.deps.fetch(config.gatewayUrl + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new EditHttpError(response.status);
    return JSON.parse(await readBoundedResponseText(response, 1000000)) as unknown;
  }
  private async authorize(config: ExtensionConfig, state: EditState): Promise<string> {
    const health = (await this.request(config, "/health")) as {
      experimental?: unknown;
      capabilities?: { browserFeatures?: unknown; browserNotesEdit?: unknown };
    };
    if (
      health?.experimental !== true ||
      !range(health.capabilities?.browserFeatures) ||
      !range(health.capabilities?.browserNotesEdit)
    )
      throw new EditHttpError(404);
    if (!state.token) {
      state.grantId ??= crypto.randomUUID();
      await this.persist(config, state);
      const response = (await this.request(config, "/browser/notes/edit/enable", config.token, {
        id: state.grantId,
      })) as {
        status?: unknown;
        credential?: { token?: unknown; deviceId?: unknown; tokenId?: unknown; scopes?: unknown };
      };
      const credential = response?.credential;
      if (
        response.status !== "approved" ||
        credential?.deviceId !== config.deviceId ||
        typeof credential.token !== "string" ||
        !credential.token.length ||
        credential.token.length > 8192 ||
        typeof credential.tokenId !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(credential.tokenId) ||
        !Array.isArray(credential.scopes) ||
        credential.scopes.length !== 1 ||
        credential.scopes[0] !== "notes:update"
      )
        throw new Error("Invalid saved-note credential");
      state.token = credential.token;
      delete state.grantId;
      await this.persist(config, state);
    }
    await this.deps.ensureRead();
    const read = await this.deps.readToken(config);
    if (!read) throw new Error("Saved notes are unavailable. Your edit is kept.");
    state.enabled = true;
    return read;
  }
  private failure(state: EditState, error: unknown): void {
    if (error instanceof EditHttpError && [401, 403, 404, 410].includes(error.status)) {
      state.enabled = false;
      state.notes = [];
      delete state.token;
    }
    state.error =
      error instanceof Error
        ? error.message
        : "Saved notes could not be loaded. Your edit is kept.";
  }
  list(url: string): Promise<NotesEditView> {
    return this.run(async () => {
      const loaded = await this.load();
      if (!loaded) return this.view();
      const { config, state } = loaded;
      const normalized = pageUrl(url);
      if (!normalized) return this.view();
      state.url = normalized;
      try {
        const read = await this.authorize(config, state);
        const result = (await this.request(
          config,
          `/browser/notes/edit?url=${encodeURIComponent(normalized)}`,
          read,
        )) as { notes?: unknown };
        if (!Array.isArray(result.notes)) throw new Error("Invalid saved-note list");
        state.notes = result.notes.slice(0, 100).flatMap((raw) => {
          const entry = note(raw);
          return entry ? [entry] : [];
        });
        delete state.error;
      } catch (error) {
        this.failure(state, error);
      }
      await this.persist(config, state);
      return this.view(state);
    });
  }
  select(id: string, url: string): Promise<NotesEditView> {
    return this.run(async () => {
      const loaded = await this.load();
      if (!loaded) return this.view();
      const { config, state } = loaded;
      const normalized = pageUrl(url);
      if (!normalized) throw new Error("Invalid page");
      const read = await this.authorize(config, state);
      const result = (await this.request(
        config,
        `/browser/notes/edit?url=${encodeURIComponent(normalized)}`,
        read,
      )) as { notes?: unknown };
      if (!Array.isArray(result.notes)) throw new Error("Invalid saved-note list");
      state.notes = result.notes
        .flatMap((raw) => {
          const entry = note(raw);
          return entry ? [entry] : [];
        })
        .slice(0, 100);
      state.url = normalized;
      const selected = state.notes.find((entry) => entry.id === id && entry.editable);
      if (!selected) throw new Error("This saved note is no longer available.");
      if (state.draft && state.draft.id !== id && state.draft.text !== state.draft.original)
        throw new Error("Save your current edit before selecting another note.");
      if (!state.draft || state.draft.id !== id)
        state.draft = {
          id,
          url: normalized,
          revision: selected.revision,
          text: selected.text,
          original: selected.text,
        };
      delete state.error;
      await this.persist(config, state);
      return this.view(state);
    });
  }
  update(text: string): Promise<NotesEditView> {
    return this.run(async () => {
      if (text.length > 8192) throw new Error("Shorten your note to 8192 characters.");
      const loaded = await this.load();
      if (!loaded?.state.draft) throw new Error("Select a saved note first.");
      loaded.state.draft.text = text;
      await this.persist(loaded.config, loaded.state);
      return this.view(loaded.state);
    });
  }
  save(): Promise<NotesEditView> {
    return this.run(async () => {
      const loaded = await this.load();
      if (!loaded) return this.view();
      if (!loaded.state.draft) throw new Error("Select a saved note first.");
      const { config, state } = loaded;
      const draft = state.draft!;
      try {
        await this.authorize(config, state);
        const result = note(
          await this.request(
            config,
            `/browser/notes/edit/${encodeURIComponent(draft.id)}`,
            state.token,
            { version: 1, url: draft.url, text: draft.text, revision: draft.revision },
            "PATCH",
          ),
        );
        if (!result || result.id !== draft.id || result.text !== draft.text.trim())
          throw new Error("Gateway did not confirm this edit.");
        state.draft = {
          ...draft,
          text: result.text,
          original: result.text,
          revision: result.revision,
        };
        state.notes = [result];
        delete state.error;
      } catch (error) {
        this.failure(state, error);
      }
      await this.persist(config, state);
      return this.view(state);
    });
  }
  discard(): Promise<NotesEditView> {
    return this.run(async () => {
      const loaded = await this.load();
      if (!loaded) return this.view();
      delete loaded.state.draft;
      delete loaded.state.error;
      await this.persist(loaded.config, loaded.state);
      return this.view(loaded.state);
    });
  }
  clear(): Promise<void> {
    return this.run(() => this.deps.write(null));
  }
}
