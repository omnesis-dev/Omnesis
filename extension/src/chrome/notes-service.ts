// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readBoundedResponseText } from "../push/response-body.js";
import type { ExtensionConfig } from "./storage.js";

export const NOTES_STATE_KEY = "omnesis.notes.state.v1";
export const MAX_NOTE_CHARS = 8192;
export interface NotePage {
  url: string;
  title: string;
  selection: string;
}
export interface NoteDraft extends NotePage {
  id: string;
  text: string;
  capturedAt: string;
  capturedTimeZoneId?: string;
  capturedUtcOffsetSeconds?: number;
}
interface QueuedNote extends NoteDraft {
  error?: string;
}
interface NotesState {
  pairing: string;
  supported: boolean;
  experimental?: boolean;
  requestId?: string;
  approvalPath?: string;
  token?: string;
  draft?: NoteDraft;
  queue: QueuedNote[];
  lastSavedId?: string;
  quarantined?: unknown[];
}
export interface NotesView {
  supported: boolean;
  enabled: boolean;
  pendingApproval: boolean;
  draft: NoteDraft | null;
  pending: number;
  lastSavedId?: string;
  error?: string;
  rejected?: { id: string; title: string }[];
}
export interface NotesDeps {
  config(): Promise<ExtensionConfig | null>;
  read(): Promise<unknown>;
  write(state: unknown): Promise<void>;
  fetch: typeof fetch;
}

export function notePage(value: unknown): NotePage | null {
  if (!value || typeof value !== "object") return null;
  const page = value as Partial<NotePage>;
  if (
    typeof page.url !== "string" ||
    page.url.length > 4096 ||
    typeof page.title !== "string" ||
    page.title.length > 512 ||
    typeof page.selection !== "string" ||
    page.selection.length > MAX_NOTE_CHARS
  )
    return null;
  try {
    const url = new URL(page.url);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? (page as NotePage)
      : null;
  } catch {
    return null;
  }
}
export function renderedNoteLength(note: NoteDraft): number {
  const title = note.title.replace(/\s+/g, " ").trim();
  return (
    note.text.trim() +
    "\n\nPage: " +
    (title ? title + " — " : "") +
    note.url +
    (note.selection
      ? "\n\nSelected passage:\n" +
        note.selection
          .split("\n")
          .map((line) => "> " + line)
          .join("\n")
      : "")
  ).length;
}
function isDraft(value: unknown): value is NoteDraft {
  if (!notePage(value)) return false;
  const draft = value as NoteDraft;
  return (
    typeof draft.id === "string" &&
    /^[a-f0-9-]{36}$/i.test(draft.id) &&
    typeof draft.text === "string" &&
    draft.text.length <= MAX_NOTE_CHARS &&
    typeof draft.capturedAt === "string" &&
    Number.isFinite(Date.parse(draft.capturedAt))
  );
}
function identity(config: ExtensionConfig): string {
  return `${config.gatewayUrl}\0${config.deviceId}`;
}
class NotesHttpError extends Error {
  constructor(readonly status: number) {
    super(`Gateway returned HTTP ${status}`);
  }
}

/** One worker-owned lane protects draft/outbox snapshots across concurrent panels and retries. */
export class NotesService {
  private lane: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: NotesDeps) {}
  private run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.lane.then(work, work);
    this.lane = result.catch(() => undefined);
    return result;
  }
  private async load(): Promise<{ config: ExtensionConfig; state: NotesState } | null> {
    const config = await this.deps.config();
    if (!config) return null;
    const raw = await this.deps.read();
    const state = raw as Partial<NotesState> | null;
    if (!state || state.pairing !== identity(config)) {
      return { config, state: { pairing: identity(config), supported: false, queue: [] } };
    }
    const queue = Array.isArray(state.queue) ? state.queue : [];
    const quarantined = Array.isArray(state.quarantined) ? [...state.quarantined] : [];
    quarantined.push(...queue.filter((item) => !isDraft(item)));
    if (state.queue !== undefined && !Array.isArray(state.queue)) quarantined.push(state.queue);
    if (state.draft && !isDraft(state.draft)) quarantined.push(state.draft);
    return {
      config,
      state: {
        pairing: identity(config),
        supported: state.supported === true && state.experimental === true,
        experimental: state.experimental === true,
        queue: queue.filter(isDraft),
        ...(isDraft(state.draft) ? { draft: state.draft } : {}),
        ...(typeof state.token === "string" ? { token: state.token } : {}),
        ...(typeof state.requestId === "string" ? { requestId: state.requestId } : {}),
        ...(typeof state.approvalPath === "string" ? { approvalPath: state.approvalPath } : {}),
        ...(typeof state.lastSavedId === "string" ? { lastSavedId: state.lastSavedId } : {}),
        ...(quarantined.length ? { quarantined } : {}),
      },
    };
  }

  private async persist(config: ExtensionConfig, state: NotesState): Promise<void> {
    const current = await this.deps.config();
    if (!current || identity(current) !== identity(config) || current.token !== config.token) {
      throw new Error("Browser pairing changed. Your note was not sent.");
    }
    await this.deps.write(state);
  }
  private async request(
    config: ExtensionConfig,
    path: string,
    token?: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.deps.fetch(`${config.gatewayUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
      credentials: "omit",
    });
    if (!response.ok) throw new NotesHttpError(response.status);
    const text = await readBoundedResponseText(response, 100000);
    return JSON.parse(text) as unknown;
  }
  private async refresh(config: ExtensionConfig, state: NotesState): Promise<void> {
    let checking: "health" | "experimental" | "credential" | "authorization" = "health";
    try {
      const health = (await this.request(config, "/health")) as {
        capabilities?: { browserNotes?: { min?: unknown; max?: unknown } };
      };
      const range = health?.capabilities?.browserNotes;
      const compatible =
        typeof range?.min === "number" &&
        typeof range.max === "number" &&
        Number.isInteger(range.min) &&
        Number.isInteger(range.max) &&
        range.min > 0 &&
        range.min <= range.max &&
        range.min <= 1 &&
        range.max >= 1;
      if (compatible) {
        checking = "experimental";
        const status = (await this.request(config, "/status", config.token)) as {
          experimental?: unknown;
        };
        state.experimental = status?.experimental === true;
        state.supported = state.experimental;
      } else {
        state.experimental = false;
        state.supported = false;
      }

      if (state.supported && state.token) {
        checking = "credential";
        await this.request(config, "/browser/notes", state.token);
      } else if (state.supported && state.requestId) {
        checking = "authorization";
        const auth = (await this.request(
          config,
          `/browser/notes/authorization/${encodeURIComponent(state.requestId)}`,
          config.token,
        )) as {
          status?: string;
          credential?: { token?: string; deviceId?: string; scopes?: string[] };
        };
        if (
          auth.status === "approved" &&
          auth.credential?.deviceId === config.deviceId &&
          auth.credential.scopes?.length === 1 &&
          auth.credential.scopes[0] === "notes:create" &&
          typeof auth.credential.token === "string" &&
          auth.credential.token.length > 0
        ) {
          state.token = auth.credential.token;
        } else if (auth.status !== "pending") {
          delete state.token;
          delete state.requestId;
          delete state.approvalPath;
        }
      }
    } catch (error) {
      // A network outage keeps drafts and authorized offline enqueue available.
      // An explicit authorization rejection always closes the feature.
      if (error instanceof NotesHttpError && [401, 403, 404, 410].includes(error.status)) {
        if (checking === "health" || checking === "experimental") {
          state.supported = false;
          state.experimental = false;
        }
        delete state.token;
        delete state.requestId;
        delete state.approvalPath;
        if (error.status === 404 && checking !== "authorization") state.supported = false;
      }
    }
    await this.persist(config, state);
  }
  private view(state?: NotesState): NotesView {
    return {
      supported: state?.supported ?? false,
      enabled: !!state?.supported && !!state.token,
      pendingApproval: !!state?.requestId && !state.token,
      draft: state?.draft ?? null,
      pending: (state?.queue.length ?? 0) + (state?.quarantined?.length ?? 0),
      lastSavedId: state?.lastSavedId,
      error: state?.quarantined?.length
        ? "Some stored notes need recovery. Their original data is kept in this browser."
        : state?.queue.find((note) => note.error)?.error,
      rejected: state?.queue
        .filter((note) => note.error)
        .map((note) => ({ id: note.id, title: note.title })),
    };
  }
  status(refresh = true): Promise<NotesView> {
    return this.run(async () => {
      const loaded = await this.load();
      if (!loaded) return this.view();
      if (refresh) await this.refresh(loaded.config, loaded.state);
      return this.view(loaded.state);
    });
  }
  activate(): Promise<string> {
    return this.run(async () => {
      const loaded = await this.load();
      if (!loaded) throw new Error("Pair this browser first");
      const { config, state } = loaded;
      await this.refresh(config, state);
      if (!state.supported) throw new Error("This gateway does not support browser notes");
      if (!state.requestId) {
        state.requestId = crypto.randomUUID();
        await this.persist(config, state);
      }
      const response = (await this.request(config, "/browser/notes/authorization", config.token, {
        id: state.requestId,
      })) as { requestId?: string; approvalPath?: string };
      if (
        typeof response.requestId !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(response.requestId) ||
        typeof response.approvalPath !== "string" ||
        !response.approvalPath.startsWith("/portal/") ||
        response.approvalPath.startsWith("//")
      ) {
        throw new Error("Gateway returned an invalid approval link");
      }
      state.requestId = response.requestId;
      state.approvalPath = response.approvalPath;
      await this.persist(config, state);
      return new URL(response.approvalPath, config.gatewayUrl).href;
    });
  }
  begin(page: NotePage): Promise<NotesView> {
    return this.run(async () => {
      if (!notePage(page)) throw new Error("This page cannot be attached to a note");
      const loaded = await this.load();
      if (!loaded) return this.view();
      const { config, state } = loaded;
      await this.refresh(config, state);
      if (!this.view(state).enabled) return this.view(state);
      // An unfinished thought keeps its original page, even if a different tab invokes the composer.
      if (!state.draft)
        state.draft = {
          ...page,
          id: crypto.randomUUID(),
          text: "",
          capturedAt: new Date().toISOString(),
          capturedTimeZoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
          capturedUtcOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        };
      await this.persist(config, state);
      return this.view(state);
    });
  }
  update(id: string, text: string, selection?: string): Promise<NotesView> {
    return this.run(async () => {
      const loaded = await this.load();
      if (!loaded) return this.view();
      const { config, state } = loaded;
      if (!state.draft || state.draft.id !== id)
        throw new Error("This draft changed in another panel");
      if (
        text.length > MAX_NOTE_CHARS ||
        (selection !== undefined && selection.length > MAX_NOTE_CHARS)
      )
        throw new Error("Note or quotation is too long");
      state.draft.text = text;
      if (selection !== undefined) state.draft.selection = selection;
      await this.persist(config, state);
      return this.view(state);
    });
  }
  submit(id: string): Promise<NotesView> {
    return this.run(async () => {
      const loaded = await this.load();
      if (!loaded) return this.view();
      const { config, state } = loaded;
      await this.refresh(config, state);
      if (!this.view(state).enabled)
        throw new Error("Tell Omnesis is unavailable. Your draft is kept.");
      if (!state.draft || state.draft.id !== id || !state.draft.text.trim())
        throw new Error("Write a note before sending");
      if (renderedNoteLength(state.draft) > MAX_NOTE_CHARS)
        throw new Error(
          "Shorten the note or quotation. The complete note can contain up to 8192 characters.",
        );
      if (state.queue.length >= 100)
        throw new Error("100 notes are waiting to sync. Your draft is kept.");
      state.queue.push(state.draft);
      delete state.draft;
      await this.persist(config, state);
      return this.view(state);
    });
  }
  drain(): Promise<NotesView> {
    return this.run(async () => {
      const loaded = await this.load();
      if (!loaded) return this.view();
      const { config, state } = loaded;
      await this.refresh(config, state);
      if (!this.view(state).enabled) return this.view(state);
      for (let attempt = 0; attempt < 10; attempt++) {
        const note = state.queue.find((item) => !item.error);
        if (!note) break;
        let retryLater = false;
        try {
          const saved = (await this.request(config, "/browser/notes", state.token, {
            version: 1,
            id: note.id,
            text: note.text,
            capturedAt: note.capturedAt,
            capturedTimeZoneId: note.capturedTimeZoneId,
            capturedUtcOffsetSeconds: note.capturedUtcOffsetSeconds,
            page: {
              url: note.url,
              title: note.title,
              ...(note.selection ? { selection: note.selection } : {}),
            },
          })) as { id?: unknown; deviceId?: unknown; surface?: unknown };
          if (
            saved?.id !== note.id ||
            saved.deviceId !== config.deviceId ||
            saved.surface !== "chrome-extension"
          )
            throw new Error("Gateway did not confirm this note");
          state.queue = state.queue.filter((item) => item.id !== note.id);
          state.lastSavedId = note.id;
        } catch (error) {
          if (error instanceof NotesHttpError && [401, 403].includes(error.status)) {
            delete state.token;
            delete state.requestId;
            retryLater = true;
          } else if (
            error instanceof NotesHttpError &&
            [400, 409, 413, 422].includes(error.status)
          ) {
            note.error = "The gateway could not accept this note. Your note is kept locally.";
          } else {
            if (error instanceof NotesHttpError && error.status === 404) state.supported = false;
            retryLater = true;
          }
        }
        await this.persist(config, state);
        if (retryLater) break;
      }
      return this.view(state);
    });
  }
  discard(id: string): Promise<NotesView> {
    return this.run(async () => {
      const loaded = await this.load();
      if (!loaded) return this.view();
      const { config, state } = loaded;
      if (!state.draft || state.draft.id !== id)
        throw new Error("This draft changed in another panel");
      delete state.draft;
      await this.persist(config, state);
      return this.view(state);
    });
  }
  restore(id: string): Promise<NotesView> {
    return this.run(async () => {
      const loaded = await this.load();
      if (!loaded) return this.view();
      const { config, state } = loaded;
      if (state.draft) throw new Error("Finish your current draft before editing an unsent note");
      const note = state.queue.find((item) => item.id === id && item.error);
      if (!note) throw new Error("This unsent note changed");
      state.draft = {
        id: crypto.randomUUID(),
        text: note.text,
        url: note.url,
        title: note.title,
        selection: note.selection,
        capturedAt: note.capturedAt,
        capturedTimeZoneId: note.capturedTimeZoneId,
        capturedUtcOffsetSeconds: note.capturedUtcOffsetSeconds,
      };
      state.queue = state.queue.filter((item) => item.id !== id);
      await this.persist(config, state);
      return this.view(state);
    });
  }
  clear(): Promise<void> {
    return this.run(() => this.deps.write(null));
  }
}
