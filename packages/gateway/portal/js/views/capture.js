// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// "Tell Omnesis" — the portal's quick-capture surface, the typed sibling of
// the mobile capture screens. A note told here lands in the built-in
// Omnesis Notes source as part of that day's note document, where it
// becomes searchable; nothing replies. Type, tell, move on.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { navigate } from "../lib/router.js";
import { createNote, deleteNoteEntry, getNotesHistory, patchNoteEntry } from "../api.js";
import { NOTE_DAY_RE, NOTES_HISTORY_PAGE_SIZE } from "../lib/notes.js";
import { useCursorPage } from "../lib/use-cursor-page.js";
import { LoadMore, cursorPageBoundaryState } from "../components/load-more.js";
import { ConfirmModal } from "../components/confirm-modal.js";
import { RowActionMenu } from "../components/row-action-menu.js";

/** The gateway's own ceiling on a note; an over-long one is refused before the round trip. */
export const MAX_NOTE_LENGTH = 8192;

/** How long the "Told Omnesis" confirmation stays before the composer returns to its resting hint. */
export const CONFIRMATION_MS = 2000;

/**
 * The capture request for one note. The client-supplied id is the
 * idempotency key: a retry of the same attempt (the first one timed out
 * after the gateway committed) re-sends it and gets the stored entry back
 * instead of a duplicate. The capture instant and zone travel with the
 * note so the day it files under is the day it was told, wherever the
 * gateway runs.
 */
export function captureRequest(text, now = new Date()) {
  return {
    id: crypto.randomUUID(),
    text,
    surface: "portal",
    capturedAt: now.toISOString(),
    capturedTimeZoneId: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    capturedUtcOffsetSeconds: -now.getTimezoneOffset() * 60,
  };
}

/** One sentence per failure the operator can act on; the note stays in the editor either way. */
export function captureErrorMessage(err) {
  switch (err?.status) {
    case 403:
      return "This browser's session can't write notes. Pair it again with a token that can.";
    case 429:
      return "Too many captures — wait a minute and try again.";
    case 400:
    case 413:
    case 422:
      return `The gateway rejected this note (${err.status}). Edit it and try again.`;
    default:
      return "Couldn't save the note — try again.";
  }
}

// Platform-aware shortcut hint — ⌘ on macOS, Ctrl elsewhere (the modifier
// onKeyDown accepts on each platform).
const modKey =
  typeof navigator !== "undefined" && navigator.platform?.includes("Mac") ? "⌘" : "Ctrl";

export function CaptureView({ day } = {}) {
  // A Manage-notes link seeds the history at that day; anything else
  // (including a malformed value) opens the latest notes.
  const seedDay = typeof day === "string" && NOTE_DAY_RE.test(day) ? day : null;
  const [text, setText] = useState("");
  // The entry the last capture returned. The history consumes it once:
  // prepended when unseeded, reloaded-from-server when seeded.
  const [lastCapture, setLastCapture] = useState(null);
  // "editing" | "saving" | "told" — the composer's phase, as on mobile.
  const [phase, setPhase] = useState("editing");
  const [error, setError] = useState(null);
  const textareaRef = useRef(null);
  const confirmationTimer = useRef(null);
  // The request of the attempt that last failed. A retry with the same
  // text re-sends it unchanged, so its idempotency key holds.
  const pendingRef = useRef(null);

  useEffect(() => {
    textareaRef.current?.focus();
    return () => clearTimeout(confirmationTimer.current);
  }, []);

  const saving = phase === "saving";

  async function tell(e) {
    if (e) e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    if (trimmed.length > MAX_NOTE_LENGTH) {
      setError(
        `Too long — notes are capped at ${MAX_NOTE_LENGTH} characters. Shorten it and try again.`,
      );
      return;
    }
    const request =
      pendingRef.current?.text === trimmed ? pendingRef.current : captureRequest(trimmed);
    pendingRef.current = request;
    setPhase("saving");
    setError(null);
    try {
      const entry = await createNote(request);
      pendingRef.current = null;
      setText("");
      setLastCapture(entry);
      setPhase("told");
      clearTimeout(confirmationTimer.current);
      confirmationTimer.current = setTimeout(() => setPhase("editing"), CONFIRMATION_MS);
    } catch (err) {
      setError(captureErrorMessage(err));
      setPhase("editing");
    }
  }

  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") tell(e);
  };

  return html`
    <div class="capture-view">
      <header class="privacy-page-header">
        <div><h1>Tell Omnesis</h1></div>
      </header>
      <div class="capture-column">
        <p class="capture-lead">
          Say what Omnesis should remember — a thought, a fact, something to follow up on. It joins
          your notes and becomes searchable; nothing replies.
        </p>
        <form class="capture-composer" onSubmit=${tell}>
          <!-- Read-only rather than disabled while saving, so focus stays in the field for the next note. -->
          <textarea
            ref=${textareaRef}
            class="capture-input"
            placeholder="What should Omnesis remember?"
            aria-label="Note"
            rows="5"
            value=${text}
            readonly=${saving}
            onInput=${(e) => setText(e.target.value)}
            onKeyDown=${onKeyDown}
          ></textarea>
          ${error
            ? html`<div class="privacy-banner error capture-error" role="alert">
                <span>${error}</span>
                <button
                  type="button"
                  class="capture-error-dismiss"
                  aria-label="Dismiss"
                  onClick=${() => setError(null)}
                >
                  ✕
                </button>
              </div>`
            : null}
          <div class="capture-actions">
            <span class="capture-hint">
              ${phase === "told"
                ? html`<span class="capture-told" role="status">✓ Told Omnesis</span>`
                : html`<kbd>${modKey}</kbd>+<kbd>Enter</kbd> to tell`}
            </span>
            <button type="submit" class="btn-primary" disabled=${saving || !text.trim()}>
              ${saving ? "Saving…" : "Tell Omnesis"}
            </button>
          </div>
        </form>
        <${NoteHistory} seedDay=${seedDay} lastCapture=${lastCapture} />
      </div>
    </div>
  `;
}

/** One sentence per note-mutation failure the operator can act on. */
function noteMutationErrorMessage(err, action) {
  switch (err?.status) {
    case 403:
      return `This browser's session can't ${action} notes. Pair it again with a token that can.`;
    case 404:
      return null;
    default:
      return `Couldn't ${action} the note — try again.`;
  }
}

/**
 * One note as a flat table row: the text on the title line with a single
 * right-justified "⋯" menu for Edit/Delete — the same row-action shell
 * the sweeps and access tables use — instead of a card with inline
 * buttons. The editor spans the full row width while open.
 */
function NoteRow({ entry, onChanged, onRemoved }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  // Synchronous re-entry guard. State-based `busy` flips only on the next
  // render, so rapid duplicate activations (double click, repeated
  // synthetic events) would all pass it and fire duplicate mutations.
  const busyRef = useRef(false);

  async function save() {
    const next = draft.trim();
    if (busyRef.current) return;
    if (!next) {
      setError("Note text must not be empty.");
      return;
    }
    if (next.length > MAX_NOTE_LENGTH) {
      setError(
        `Too long — notes are capped at ${MAX_NOTE_LENGTH} characters. Shorten it and try again.`,
      );
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const updated = await patchNoteEntry(entry.id, next);
      onChanged(updated);
      setEditing(false);
    } catch (err) {
      // A 404 means the note is already gone: converge on the end state
      // rather than reporting a failure.
      if (err?.status === 404) {
        onRemoved(entry.id);
        return;
      }
      setError(noteMutationErrorMessage(err, "save"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function destroy() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await deleteNoteEntry(entry.id);
      onRemoved(entry.id);
    } catch (err) {
      if (err?.status === 404) {
        onRemoved(entry.id);
        return;
      }
      setError(noteMutationErrorMessage(err, "delete"));
      setConfirming(false);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function startEditing() {
    setDraft(entry.text);
    setError(null);
    setEditing(true);
  }

  if (editing) {
    return html`
      <tr class="note-row" key=${entry.id}>
        <td colspan="2">
          <div class="note-edit">
            <textarea
              class="capture-input note-edit-input"
              aria-label="Edit note"
              rows="3"
              value=${draft}
              disabled=${busy}
              onInput=${(e) => setDraft(e.target.value)}
            ></textarea>
            ${error && html`<div class="privacy-banner error capture-error" role="alert">${error}</div>`}
            <div class="note-item-actions">
              <button type="button" class="btn-primary" disabled=${busy} onClick=${save}>
                ${busy ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                class="btn-secondary"
                disabled=${busy}
                onClick=${() => { setEditing(false); setError(null); }}
              >
                Cancel
              </button>
            </div>
          </div>
        </td>
      </tr>
    `;
  }
  return html`
    <tr class="note-row" key=${entry.id}>
      <td>
        <p class="note-item-text">${entry.text}</p>
        ${entry.updatedAt && entry.updatedAt !== entry.capturedAt &&
          // The row already files under a day header — a relative
          // timestamp would repeat it. Only an edit marker carries
          // new information.
          html`
            <div class="note-item-meta"><span>edited</span></div>
          `}
        ${error && html`<div class="privacy-banner error capture-error" role="alert">${error}</div>`}
      </td>
      <td class="portal-table-actions-col">
        <${RowActionMenu}
          label=${"Actions for this note"}
          items=${[
            { label: "Edit", onSelect: startEditing, disabled: busy },
            {
              label: "Delete",
              danger: true,
              disabled: busy,
              onSelect: () => { setError(null); setConfirming(true); },
            },
          ]}
        />
        <${ConfirmModal}
          open=${confirming}
          title="Delete this note?"
          body="The note is removed from its day's search document too. Other notes from that day stay."
          confirmLabel=${busy ? "Deleting…" : "Delete"}
          destructive
          confirmDisabled=${busy}
          cancelDisabled=${busy}
          onConfirm=${destroy}
          onCancel=${() => setConfirming(false)}
        />
      </td>
    </tr>
  `;
}

/**
 * Whether a locally saved pin outranks a history snapshot copy of the
 * same entry. Instants are canonical UTC ISO, so a version mismatch is
 * decided by recency; without comparable versions any content difference
 * means the snapshot is older. A snapshot at the same version (or newer,
 * e.g. edited on another device) retires the pin instead.
 */
function pinWinsOver(pin, current) {
  if (pin?.updatedAt && current?.updatedAt && pin.updatedAt !== current.updatedAt) {
    return pin.updatedAt > current.updatedAt;
  }
  return pin?.text !== current?.text;
}

function NoteHistory({ seedDay, lastCapture }) {
  const page = useCursorPage({
    resetKey: seedDay ?? "latest",
    pageSize: NOTES_HISTORY_PAGE_SIZE,
    // The seed positions the first page only: a cursor already positions
    // the feed, and the route rejects the combination with a 400.
    loadPage: ({ limit, cursor }) =>
      getNotesHistory({ limit, cursor, day: cursor ? undefined : seedDay }),
    selectItems: (payload) => payload?.entries ?? [],
    itemKey: (item) => item?.id,
  });
  const boundary = cursorPageBoundaryState(page);
  const consumedCaptureRef = useRef(null);
  // Entries captured locally while a load is in flight, newest first. A
  // reset response that started before the capture replaces the items
  // wholesale and would erase a note the user just saw confirmed — the
  // reconciler below re-asserts any pin the settled list is missing.
  const freshRef = useRef([]);

  // Fold a fresh capture into the list once. Unseeded, it belongs on top;
  // seeded, the day bound excludes it, so reload from the server instead.
  useEffect(() => {
    if (!lastCapture || consumedCaptureRef.current === lastCapture.id) return;
    consumedCaptureRef.current = lastCapture.id;
    if (seedDay) {
      page.reload();
      return;
    }
    page.setItems((items) =>
      items.some((item) => item?.id === lastCapture.id) ? items : [lastCapture, ...items],
    );
    freshRef.current = [
      lastCapture,
      ...freshRef.current.filter((entry) => entry?.id !== lastCapture.id),
    ].slice(0, 20);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastCapture, seedDay]);

  // Reconcile local pins with the settled list. A stale reset response
  // (one that started before a local save) either omits the pin or
  // carries an older copy of it — the pin is the latest locally saved
  // version, so a missing pin is re-asserted on top and an outdated copy
  // is replaced in place. A snapshot at the same version (or newer, e.g.
  // edited elsewhere) retires the pin. Deleting a pinned note purges its
  // pin via onRemoved below.
  useEffect(() => {
    if (seedDay || freshRef.current.length === 0 || page.loading) return;
    const byId = new Map(page.items.map((item) => [item?.id, item]));
    const missing = [];
    const nextItems = [...page.items];
    let changed = false;
    const remaining = [];
    for (const pin of freshRef.current) {
      const current = byId.get(pin?.id);
      if (!current) {
        missing.push(pin);
        remaining.push(pin);
        changed = true;
      } else if (pinWinsOver(pin, current)) {
        nextItems[nextItems.indexOf(current)] = pin;
        remaining.push(pin);
        changed = true;
      }
    }
    freshRef.current = remaining;
    if (changed) {
      const ordered = missing.length > 0 ? [...missing, ...nextItems] : nextItems;
      page.setItems(ordered);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedDay, page.items, page.loading]);

  // Group the ordered items under day headers for scannability.
  const groups = [];
  for (const entry of page.items) {
    const last = groups[groups.length - 1];
    if (last && last.day === entry.day) last.entries.push(entry);
    else groups.push({ day: entry.day, entries: [entry] });
  }

  return html`
    <section class="capture-history" aria-label="Your notes">
      <h2 class="capture-history-title">Your notes</h2>
      ${seedDay && html`<div class="sources-banner-v2 info capture-seed-banner">
        <span>Showing notes from <strong>${seedDay}</strong> and older.</span>
        ${" "}
        <a
          href="/portal/capture"
          onClick=${(e) => { e.preventDefault(); navigate("/portal/capture"); }}
        >Show latest</a>
      </div>`}
      ${page.loading && !page.loaded && html`<div class="loading"><span class="spinner"></span> Loading notes…</div>`}
      ${page.error && !page.loaded && html`<div class="sources-banner-v2 error" role="alert">
        <span>Couldn't load notes. ${page.error?.message ?? String(page.error)}</span>
        ${" "}
        <button type="button" class="btn-secondary" onClick=${page.reload}>Retry</button>
      </div>`}
      ${page.loaded && page.items.length === 0 && !page.error && html`<div class="empty-state">
        <p class="muted">
          ${seedDay ? `No notes on or before ${seedDay}.` : "No notes yet — tell Omnesis something above."}
        </p>
      </div>`}
      ${groups.map((group) => html`
        <div key=${group.day}>
          <h3 class="capture-day">${group.day}</h3>
          <div class="portal-table-wrap">
            <table class="portal-table notes-table">
              <tbody>
                ${group.entries.map((entry) => html`
                  <${NoteRow}
                    key=${entry.id}
                    entry=${entry}
                    onChanged=${(updated) => {
                      // A successful save is the newest known version of this
                      // entry: pin it so a stale in-flight snapshot cannot
                      // revert the corrected text (missing-ID and older-copy
                      // cases alike). The pin retires once a settled list
                      // shows the same version.
                      freshRef.current = [
                        updated,
                        ...freshRef.current.filter((pinned) => pinned?.id !== updated?.id),
                      ].slice(0, 20);
                      page.replaceItem(updated.id, updated);
                    }}
                    onRemoved=${(id) => {
                      // A deleted pin must stay deleted: purge it so the
                      // reconciler above cannot re-assert it (the hook's own
                      // tombstone separately filters late server echoes).
                      freshRef.current = freshRef.current.filter((pinned) => pinned?.id !== id);
                      page.removeItem(id);
                    }}
                  />
                `)}
              </tbody>
            </table>
          </div>
        </div>
      `)}
      <${LoadMore}
        hasMore=${boundary.hasMore}
        loading=${boundary.loading}
        error=${boundary.error}
        onLoadMore=${boundary.onLoadMore}
        label="Load older notes"
      />
    </section>
  `;
}
