// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Settings → OMNESIS.md — the operator's standing instructions to the agent.
 *
 * One optional Markdown file in the gateway's config directory, read into the
 * system prompt of every agent run: the conversational agent, its sub-agents,
 * and the background agent that maintains loops and briefs.
 *
 * This page is deliberately thinner than the privacy-policy editor next door.
 * That one carries version history, a diff and an "affected access" confirm
 * step because saving it changes what may leave the machine. This file changes
 * how the agent behaves, has no blast radius on who can read what, and — the
 * decisive difference — is equally editable in a terminal. A portal-only
 * history would record half the edits and imply it had them all, so the file on
 * disk is the whole story and `updatedAt` is the only bookkeeping: a save built
 * on a version someone has since replaced comes back as a conflict rather than
 * quietly winning.
 */

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";

import {
  deleteOperatorInstructions,
  getOperatorInstructions,
  saveOperatorInstructions,
} from "../api.js";
import { ConfirmModal } from "../components/confirm-modal.js";
import { CopyIconButton } from "../components/copy-button.js";
import { Loading } from "../components/loading.js";
import { TextEditor } from "../lib/json-editor.js";
import { errorMessage } from "./access/shared.js";

/**
 * Seeded into the editor when the file does not exist yet — a shape to write
 * into, not content. Nothing is written until the operator saves, so declining
 * to save leaves the gateway exactly as it was: with no OMNESIS.md at all.
 */
const STARTER = `# OMNESIS.md

Standing instructions for the Omnesis agent. Everything here is read on every
run — keep it short and durable, and delete anything that stops being true.

## About me

## How I want answers

## Conventions
`;

/** Where an unsaved draft is mirrored while the operator is away from the tab. */
const DRAFT_KEY = "omnesis:omnesis-md-draft";

function restoreDraft() {
  try {
    return sessionStorage.getItem(DRAFT_KEY);
  } catch {
    return null;
  }
}

/** UTF-8 byte length, since the gateway's cap counts bytes, not characters. */
function byteLength(text) {
  return new TextEncoder().encode(text ?? "").length;
}

export function OmnesisMdView() {
  const [file, setFile] = useState(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = async ({ keepDraft = false } = {}) => {
    try {
      const next = await getOperatorInstructions();
      setFile(next);
      setFailed(false);
      if (!keepDraft) {
        setDraft(restoreDraft() ?? next.content ?? "");
        setEditing(next.exists === true || restoreDraft() !== null);
      }
      return next;
    } catch (err) {
      // Keep whatever was last known rather than blanking the page: a failed
      // refresh should not look like an empty gateway. `failed` is what the
      // render branches on, so there is always a banner and a way back.
      setFailed(true);
      setNotice({ kind: "error", message: errorMessage(err, "OMNESIS.md could not be read.") });
      return null;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Loaded once when the tab opens; every mutation below re-reads for itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = file !== null && editing && draft !== (file.content ?? "");

  // The draft is the only copy of words the operator has not saved, and
  // switching Settings tabs unmounts this view. Mirror it per keystroke and
  // warn on a real page unload, the way the policy editor next door does.
  useEffect(() => {
    if (!dirty) {
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {
        /* storage unavailable — the draft simply is not mirrored */
      }
      return undefined;
    }
    try {
      sessionStorage.setItem(DRAFT_KEY, draft);
    } catch {
      /* storage unavailable */
    }
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, draft]);

  const bytes = byteLength(draft);
  const overCap = file !== null && bytes > file.maxBytes;
  // The gateway says WHY a file it could not load is unavailable, so the editor
  // never has to infer it from an empty body — opening on that inference would
  // put an empty document over a real file on the next save.
  const unloadable = file?.problem != null;

  async function save() {
    if (!file || busy || overCap) return;
    setBusy(true);
    setNotice(null);
    try {
      // `updatedAt` is null when there is no file, and null is a real claim —
      // "I expect none" — so the create is checked too. Sending nothing there
      // would let this tab silently overwrite a file written in a terminal
      // while it sat open, which is exactly what the page invites.
      const next = await saveOperatorInstructions(draft, file.updatedAt);
      setFile(next);
      setDraft(next.content ?? "");
      setEditing(true);
      setNotice({ kind: "success", message: "Saved. The next agent run reads it." });
    } catch (err) {
      if (err?.status === 409) {
        // Keep the draft — the operator's words are the thing worth protecting
        // — and show them what is on disk now so they can reconcile.
        const latest = await load({ keepDraft: true });
        setNotice({
          kind: "warning",
          message: latest
            ? "OMNESIS.md changed on disk since this tab loaded — someone edited it elsewhere. Your text is still here; discard it to see the current file, or save again to overwrite."
            : errorMessage(err, "OMNESIS.md could not be saved."),
        });
      } else {
        setNotice({ kind: "error", message: errorMessage(err, "OMNESIS.md could not be saved.") });
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!file || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await deleteOperatorInstructions(file.updatedAt);
      setConfirmDelete(false);
      // The delete succeeded whether or not the re-read does, so say so first;
      // a failed reload then adds its own banner rather than replacing this.
      setFile(null);
      setDraft("");
      setEditing(false);
      const next = await load();
      if (next) {
        setNotice({ kind: "success", message: "Deleted. The agent runs on its defaults again." });
      }
    } catch (err) {
      setConfirmDelete(false);
      setNotice({
        kind: err?.status === 409 ? "warning" : "error",
        message:
          err?.status === 409
            ? "OMNESIS.md changed on disk since this tab loaded. Reload before deleting it."
            : errorMessage(err, "OMNESIS.md could not be deleted."),
      });
      await load({ keepDraft: true });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return html`<${Loading} label="Loading OMNESIS.md…" />`;

  return html`<div class="omnesis-md-view">
    <header class="omnesis-md-header">
      <h2>OMNESIS.md</h2>
      <p class="omnesis-md-lede">
        Your standing instructions to the agent — who you are, how you want to be
        answered, conventions you expect it to keep. Every agent run reads them,
        from the agent you chat with to the background agent; the privacy
        reviewer does not, so nothing here widens what leaves this machine.
      </p>
      ${file
        ? html`<p class="omnesis-md-path">
            <code>${file.path}</code>
            <${CopyIconButton} text=${file.path} class="omnesis-md-copy" title="Copy the path" />
            <span class="omnesis-md-path-note">
              Edit it here or in your own editor — whichever wrote last is what the
              agent reads.
            </span>
          </p>`
        : null}
    </header>

    ${notice
      ? html`<div
          class=${`omnesis-md-banner ${notice.kind}`}
          role=${notice.kind === "error" ? "alert" : "status"}
        >
          <span>${notice.message}</span>
          ${failed
            ? html`<button
                type="button"
                class="btn-secondary omnesis-md-retry"
                disabled=${busy}
                onClick=${() => load({ keepDraft: dirty })}
              >
                Try again
              </button>`
            : null}
        </div>`
      : null}

    ${file?.truncated && !unloadable
      ? html`<div class="omnesis-md-banner warning" role="status">
          This file is ${file.bytes.toLocaleString()} bytes. Only the first
          ${file.maxBytes.toLocaleString()} reach the agent — the rest is cut off.
        </div>`
      : null}

    ${unloadable
      ? html`<div class="omnesis-md-banner error" role="alert">
          <span>
            ${file.problem === "too-large"
              ? `This file is ${file.bytes.toLocaleString()} bytes — far past the ${file.maxBytes.toLocaleString()}-byte limit, so the agent ignores it entirely and it is not loaded here. Trim it in your own editor, or delete it.`
              : "This file cannot be read — check its permissions. The agent gets nothing from it until it can be read."}
          </span>
          <button
            type="button"
            class="btn-secondary omnesis-md-delete"
            disabled=${busy}
            onClick=${() => setConfirmDelete(true)}
          >
            Delete file
          </button>
        </div>`
      : null}

    ${file && !file.exists && !editing
      ? html`<div class="omnesis-md-empty">
          <p>
            There is no OMNESIS.md yet, and the agent runs on its defaults. Write
            one when you have something durable to tell it.
          </p>
          <button
            type="button"
            class="btn-primary"
            onClick=${() => {
              setDraft(STARTER);
              setEditing(true);
              setNotice(null);
            }}
          >
            Write OMNESIS.md
          </button>
        </div>`
      : null}

    ${editing && !unloadable
      ? html`<section class="omnesis-md-editor-section">
          <div class="omnesis-md-label">Instructions (Markdown)</div>
          <div class="omnesis-md-code-editor">
            <${TextEditor}
              value=${draft}
              ariaLabel="OMNESIS.md instructions"
              wrap
              onChange=${(value) => {
                setDraft(value);
                setNotice(null);
              }}
            />
          </div>
          <div class="omnesis-md-toolbar">
            <span class="omnesis-md-status">
              <span class=${overCap ? "omnesis-md-bytes over" : "omnesis-md-bytes"}>
                ${bytes.toLocaleString()} / ${(file?.maxBytes ?? 0).toLocaleString()} bytes
              </span>
              ${file?.exists
                ? html`<button
                    type="button"
                    class="btn-ghost omnesis-md-delete"
                    disabled=${busy}
                    onClick=${() => setConfirmDelete(true)}
                  >
                    Delete file
                  </button>`
                : null}
            </span>
            <span class="omnesis-md-actions">
              <button
                type="button"
                class="btn-secondary"
                disabled=${busy || (!dirty && file?.exists === true)}
                onClick=${() => {
                  setDraft(file?.content ?? "");
                  setEditing(file?.exists === true);
                  setNotice(null);
                }}
              >
                Discard changes
              </button>
              <button
                type="button"
                class="btn-primary"
                disabled=${busy || overCap || draft.trim() === "" || (file?.exists === true && !dirty)}
                onClick=${save}
              >
                ${busy ? "Saving…" : "Save"}
              </button>
            </span>
          </div>
        </section>`
      : null}

    <${ConfirmModal}
      open=${confirmDelete}
      title="Delete OMNESIS.md?"
      body=${html`<p>
        The file is removed from disk and the agent goes back to its defaults on
        the next run. There is no version history to restore it from.${dirty
          ? " Your unsaved changes go with it."
          : ""}
      </p>`}
      confirmLabel=${busy ? "Deleting…" : "Delete file"}
      cancelLabel="Keep it"
      destructive
      confirmDisabled=${busy}
      onConfirm=${remove}
      onCancel=${() => setConfirmDelete(false)}
    />
  </div>`;
}
