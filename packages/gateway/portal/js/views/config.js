// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Config view facade for Settings → Config.
 *
 * This module owns config loading, live refresh, draft staging, the shared
 * Save → review-diff → confirm flow, mode switching, and the raw JSON
 * editor. Recursive layout, records, and filtering live in
 * config-structured-form.js; leaf widgets, defaults, and field validation live
 * in config-field-controls.js; draft helpers and the review list live in
 * config-draft.js. Add behavior to the focused collaborator.
 */

import { html } from "htm/preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  getAdminConfig,
  getAdminConfigRaw,
  getAdminConfigStatus,
  getAdminConfigSchema,
  patchAdminConfig,
  putAdminConfig,
  getAdminSources,
} from "../api.js";
import { JsonEditor } from "../lib/json-editor.js";
import { Segmented } from "../components/segmented.js";
import { ConfirmModal } from "../components/confirm-modal.js";
import { StructuredForm } from "./config-structured-form.js";
import { PrivacyPolicyDiff } from "./policies/policy.js";
import { setRouteLeaveGuard } from "../lib/router.js";
import {
  applyMergePatchToDraft,
  canonicalJson,
  diffConfigs,
  dirtyPathsFor,
  jsonEqual,
  mergePatchFromDiffs,
  parseRawText,
} from "./config-draft.js";

// ---------------------------------------------------------------------------
// Live-refresh event bridge
// ---------------------------------------------------------------------------

/**
 * Subscribe to config-change events from the gateway's admin SSE stream.
 * Re-invokes `onChange` any time another writer (CLI, vim, another tab)
 * mutates the file. EventSource carries the portal session cookie on the
 * same-origin `/admin/config/events` request and auto-reconnects across
 * gateway restarts or transient network errors.
 *
 * Returns an unsubscribe that closes the socket and stops reconnects.
 */
function connectConfigEvents(onChange) {
  if (typeof EventSource === "undefined") return () => {};
  const es = new EventSource("/admin/config/events", { withCredentials: true });
  es.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (Array.isArray(msg?.changedPaths)) onChange();
    } catch { /* ignore parse errors */ }
  });
  return () => {
    es.close();
  };
}

export function isLatestConfigRefresh(sequence, latestSequence) {
  return sequence === latestSequence;
}

/**
 * Another writer changed the file while a save review was open. The review
 * stays open so the user sees what happened, but confirming is disabled
 * until they close it and re-review: the stored diff and payload reference
 * the older committed config and could silently revert the other writer's
 * keys. A closed review (null) stays closed.
 */
export function markReviewStale(review) {
  if (!review) return null;
  return { ...review, stale: true };
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function fmtPath(path) {
  return path || "/";
}

function renderErrors(errors) {
  if (!errors?.length) return null;
  return html`
    <ul class="config-errors">
      ${errors.map((e, i) => html`
        <li key=${i}><code>${fmtPath(e.path)}</code> ${e.message}</li>
      `)}
    </ul>
  `;
}

// ---------------------------------------------------------------------------
// Raw JSON editor
// ---------------------------------------------------------------------------

function RawEditor({ text, onTextChange, busy, serverErrors }) {
  // Client-side JSON check mirrors what the editor itself shows inline; we
  // surface it as a pill. The shared Save bar stays disabled until the text
  // parses — nothing here writes to the gateway directly. Read-only while a
  // save is in flight so typed-during-flight input can't be silently
  // discarded by the post-save draft clear.
  const parsed = parseRawText(text);
  const parseError = parsed.ok ? null : parsed.error;

  return html`
    <div class="config-raw">
      <div class="config-raw-toolbar">
        <span class=${`config-raw-status ${parseError ? "bad" : "good"}`}>
          ${parseError ? `JSON error: ${parseError}` : "Valid JSON"}
        </span>
      </div>
      ${serverErrors ? renderErrors(serverErrors) : null}
      <div class="config-raw-editor">
        <${JsonEditor} value=${text} onChange=${onTextChange} readOnly=${busy} />
      </div>
      <p class="config-raw-hint">
        Full replace semantics (PUT) once saved. Edits stage locally — Save
        shows a diff to review and confirm. Switching views keeps staged
        edits; leaving Settings discards them.
      </p>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function ConfigView() {
  const [mode, setMode] = useState("structured");
  const [config, setConfig] = useState(null);
  const [schema, setSchema] = useState(null);
  const [version, setVersion] = useState(0);
  const [rawText, setRawText] = useState("");
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [loadError, setLoadError] = useState(null);
  // Known bug: #88 — a rejected field keeps its server error until the
  // next mutation, Discard or an external change, even once it is corrected.
  const [serverErrors, setServerErrors] = useState(null);
  const [externalRevision, setExternalRevision] = useState(0);
  // Staged working copy. `draft` is the edited config object (null = clean);
  // `rawTextLocal` is the raw editor's uncommitted text (null = showing the
  // derived text). Both views edit the same draft: raw keystrokes that parse
  // adopt into it, structured edits fold into it, and mode switches need no
  // transfer. Unmounting (tab switch, route away) drops both unwritten.
  const [draft, setDraft] = useState(null);
  const [rawTextLocal, setRawTextLocal] = useState(null);
  // Open save-review modal: the diff plus what confirming persists.
  const [review, setReview] = useState(null);
  // Another writer touched the file while edits were staged. The draft is
  // kept; the review diff is computed against the latest committed config.
  const [externalNotice, setExternalNotice] = useState(false);
  const draftRef = useRef(null);
  const rawTextLocalRef = useRef(null);
  const configRef = useRef(null);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { rawTextLocalRef.current = rawTextLocal; }, [rawTextLocal]);
  useEffect(() => { configRef.current = config; }, [config]);
  const configVersionRef = useRef(null);
  const patchInFlightRef = useRef(false);
  const pendingEventRefreshRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const successTimerRef = useRef(null);
  // Set of sourceIds the gateway reports as push-based (hosted on a phone
  // app). The Structured form uses it to disable the inert per-source knobs
  // (syncInterval, extractAttachments, …) for those sources. Derived field, so
  // the form gates without knowing any specific source name.
  const [pushBasedSources, setPushBasedSources] = useState(() => new Set());

  const clearSuccessTimer = () => {
    if (successTimerRef.current !== null) {
      clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }
  };

  const refresh = async ({ fromEvent = false } = {}) => {
    if (fromEvent && patchInFlightRef.current) {
      pendingEventRefreshRef.current = true;
      return;
    }
    const sequence = ++refreshSequenceRef.current;
    try {
      const [c, r, s] = await Promise.all([getAdminConfig(), getAdminConfigRaw(), getAdminConfigStatus()]);
      if (!isLatestConfigRefresh(sequence, refreshSequenceRef.current)) return;
      const previousVersion = configVersionRef.current;
      const externalChange =
        fromEvent && previousVersion !== null && c.version !== previousVersion;
      setConfig(c.config);
      setVersion(c.version);
      configVersionRef.current = c.version;
      setRawText(r);
      setStatus(s);
      setLoadError(null);
      if (externalChange) {
        clearSuccessTimer();
        setServerErrors(null);
        setFlash(null);
        // Staged edits survive another writer's change: the form keeps
        // rendering the draft, and the toolbar diff recomputes against the
        // refreshed committed config. An open review stays open but goes
        // stale — confirming is disabled until it is closed and re-reviewed
        // against the latest base.
        if (draftRef.current !== null || rawTextLocalRef.current !== null) {
          setExternalNotice(true);
          setReview((prev) => markReviewStale(prev));
        }
        // Leaf editors use this token to discard a rejected local draft whose
        // committed value may be unchanged after external repair. The form's
        // search/filter/record state remains intact.
        setExternalRevision((revision) => revision + 1);
      }
    } catch (e) {
      if (!isLatestConfigRefresh(sequence, refreshSequenceRef.current)) return;
      setLoadError(e?.message ?? String(e));
    }
  };

  useEffect(() => { refresh(); }, []);
  useEffect(() => connectConfigEvents(() => refresh({ fromEvent: true })), []);
  useEffect(() => () => clearSuccessTimer(), []);
  // The schema descriptor is static (derived from the build's schema), so
  // fetch it once rather than on every config refresh.
  useEffect(() => { getAdminConfigSchema().then(setSchema).catch(() => {}); }, []);
  // Which sources are push-based — needed to gate the inert per-source knobs.
  // Registration changes are rare relative to config edits, so fetch once on
  // mount (best-effort; an empty set just means no knob is gated).
  useEffect(() => {
    getAdminSources()
      .then((res) => {
        const ids = (res.items || []).filter((s) => s.pushBased).map((s) => s.id);
        setPushBasedSources(new Set(ids));
      })
      .catch(() => {});
  }, []);

  const flashBanner = useMemo(() => {
    if (!flash) return null;
    return html`<div class=${`config-banner ${flash.kind}`}>${flash.message}</div>`;
  }, [flash]);

  const flashOk = (msg) => {
    clearSuccessTimer();
    const next = { kind: "success", message: msg };
    setFlash(next);
    successTimerRef.current = setTimeout(() => {
      setFlash((current) => (current === next ? null : current));
      successTimerRef.current = null;
    }, 2500);
  };
  const flashErr = (msg) => {
    clearSuccessTimer();
    setFlash({ kind: "error", message: msg });
  };

  // A structured field edit stages into the draft; nothing reaches the
  // gateway until Save + confirm. The raw buffer is cleared when it holds
  // the serialization of the pre-edit draft, so the Raw view reflects the
  // new draft; an out-of-sync buffer (invalid or diverged JSON the user
  // typed) is left alone for them to reconcile on return.
  function stagePatch(patch) {
    const before = draftRef.current ?? configRef.current;
    const next = applyMergePatchToDraft(before, patch);
    // Keystrokes now commit live: typing then deleting (or focusing and
    // blurring an untouched field) nets no change, so stage nothing and
    // keep Discard and the leave guard quiet on phantoms.
    if (jsonEqual(next, before)) return;
    setDraft(next);
    setRawTextLocal((prev) => {
      if (prev === null) return prev;
      try {
        return jsonEqual(JSON.parse(prev), before) ? null : prev;
      } catch {
        return prev;
      }
    });
  }

  // Raw keystrokes update the text buffer; states that parse adopt into the
  // shared draft so switching views never loses work. Echoes are ignored:
  // the editor re-fires onChange for its prop-sync overwrites (e.g. the
  // canonical text arriving after a save), which must not resurrect a draft.
  function handleRawTextChange(text) {
    const current = rawTextLocal ?? (draft ? `${JSON.stringify(draft, null, 2)}\n` : rawText);
    if (text === current) return;
    setRawTextLocal(text);
    try {
      setDraft(JSON.parse(text));
    } catch {
      // Keep the last valid draft; Save stays disabled until it parses.
    }
  }

  function discardDrafts() {
    setDraft(null);
    setRawTextLocal(null);
    setExternalNotice(false);
    setServerErrors(null);
    // A rejection banner describes the draft being dropped; a success flash
    // describes the committed state and stays.
    setFlash((current) => (current?.kind === "error" ? null : current));
    setReview(null);
    // Record editors hold unpersisted added keys outside the draft; the
    // token tells them to drop rows that never materialized server-side.
    setExternalRevision((revision) => revision + 1);
  }

  // One wrapper for both persistence paths: stale-refresh invalidation, the
  // in-flight guard that defers SSE refreshes, error mapping, and the
  // deferred-refresh drain. The `commit` callback runs the mutation and
  // settles committed state; it returns true when the gateway accepted it.
  async function runMutation(commit) {
    // A refresh that started before this mutation can only contain older
    // state. Invalidate it; an SSE event during the mutation is deferred and
    // fetches the authoritative snapshot afterward.
    refreshSequenceRef.current += 1;
    patchInFlightRef.current = true;
    setBusy(true);
    setServerErrors(null);
    try {
      return await commit();
    } catch (e) {
      flashErr(e?.message ?? String(e));
      return false;
    } finally {
      patchInFlightRef.current = false;
      setBusy(false);
      if (pendingEventRefreshRef.current) {
        pendingEventRefreshRef.current = false;
        void refresh({ fromEvent: true });
      }
    }
  }

  // PATCH persists the structured draft. An unparseable raw buffer is kept
  // (not cleared): it was never part of this payload, and dropping it would
  // surprise the user on return to Raw. The optimistic raw text avoids a
  // stale-text flash before the canonical refetch lands.
  async function submitPatch(patch) {
    await runMutation(async () => {
      const { ok, body } = await patchAdminConfig(patch);
      if (!ok) {
        setServerErrors(Array.isArray(body?.detail) ? body.detail : null);
        flashErr(body?.error || "Validation failed");
        return false;
      }
      // Response carries the fresh config; skip the extra round-trip.
      setConfig(body.config);
      setVersion(body.version);
      configVersionRef.current = body.version;
      setDraft(null);
      setExternalNotice(false);
      setExternalRevision((revision) => revision + 1);
      // A raw buffer holding exactly the saved state is consumed; anything
      // else (unparseable keystrokes the draft never adopted) is kept for
      // the user to reconcile on return to Raw.
      setRawTextLocal((prev) => {
        if (prev === null) return prev;
        try {
          return jsonEqual(JSON.parse(prev), body.config) ? null : prev;
        } catch {
          return prev;
        }
      });
      setRawText(`${JSON.stringify(body.config, null, 2)}\n`);
      if (body.changedPaths?.length) {
        flashOk(`Saved (${body.changedPaths.length} path${body.changedPaths.length === 1 ? "" : "s"}).`);
      } else {
        flashOk("Saved — already up to date.");
      }
      // Pull the canonical text so the Raw tab reflects the latest write.
      try { setRawText(await getAdminConfigRaw()); } catch { /* best-effort */ }
      return true;
    });
  }

  // PUT persists the raw draft. The buffer is consumed by the save, so it
  // clears alongside the draft.
  async function submitPut(value) {
    await runMutation(async () => {
      const { ok, body } = await putAdminConfig(value);
      if (!ok) {
        setServerErrors(Array.isArray(body?.detail) ? body.detail : null);
        flashErr(body?.error || "Validation failed");
        return false;
      }
      setConfig(body.config);
      setVersion(body.version);
      configVersionRef.current = body.version;
      setDraft(null);
      setRawTextLocal(null);
      setExternalNotice(false);
      setExternalRevision((revision) => revision + 1);
      setRawText(`${JSON.stringify(value, null, 2)}\n`);
      if (body.changedPaths?.length) {
        flashOk("Config replaced.");
      } else {
        flashOk("Saved — already up to date.");
      }
      // Re-read the canonical text rather than trusting the echo.
      try { setRawText(await getAdminConfigRaw()); } catch { /* best-effort */ }
      return true;
    });
  }

  // Text the raw editor shows: uncommitted keystrokes first, then the
  // serialization of a structured draft, then the committed file text.
  const rawDisplayText = rawTextLocal ?? (draft ? `${JSON.stringify(draft, null, 2)}\n` : rawText);

  const rawParse = useMemo(() => {
    if (mode !== "raw") return null;
    return parseRawText(rawDisplayText);
  }, [mode, rawDisplayText]);

  // What Save would ask to confirm: the working copy (structured) or the
  // parsed raw text (raw) diffed against the committed config.
  const pendingDiffs = useMemo(() => {
    if (config === null) return [];
    if (mode === "structured") {
      if (!draft) return [];
      return diffConfigs(config, draft);
    }
    if (!rawParse?.ok) return [];
    return diffConfigs(config, rawParse.value);
  }, [mode, config, draft, rawParse]);

  // Mode-independent dirty set for the form's modified-field highlighting.
  const dirtyPaths = useMemo(
    () => dirtyPathsFor(config ?? {}, draft),
    [config, draft],
  );

  const hasStagedEdits = draft !== null || rawTextLocal !== null;
  const saveDisabled = busy || pendingDiffs.length === 0 || (mode === "raw" && !rawParse?.ok);

  // Leaving with staged edits discards them: the native dialog for reload /
  // tab-close (same precedent as the omnesis-md and policy editors), plus
  // the router guard for in-app navigation (settings tabs, sidebar).
  useEffect(() => {
    if (!hasStagedEdits) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasStagedEdits]);

  useEffect(() => {
    setRouteLeaveGuard(
      hasStagedEdits
        ? () => "You have unsaved config changes. Leave without saving?"
        : null,
    );
    return () => setRouteLeaveGuard(null);
  }, [hasStagedEdits]);

  const openReview = () => {
    if (saveDisabled) return;
    // A root-level diff (the whole document replaced — only reachable from
    // raw text that parses to a non-object) is not expressible as a merge
    // patch, so even Structured persists it with a full PUT.
    const rootReplaced = pendingDiffs.some((entry) => entry.path.length === 0);
    const candidate = mode === "raw" ? rawParse.value : draft;
    if (mode === "raw" || rootReplaced) {
      setReview({
        diffs: pendingDiffs,
        saveKind: "put",
        payload: candidate,
        beforeText: canonicalJson(config),
        afterText: canonicalJson(candidate),
      });
    } else {
      setReview({
        diffs: pendingDiffs,
        saveKind: "patch",
        payload: mergePatchFromDiffs(pendingDiffs),
        beforeText: canonicalJson(config),
        afterText: canonicalJson(candidate),
      });
    }
  };

  const confirmReview = () => {
    const current = review;
    setReview(null);
    if (!current) return;
    if (current.saveKind === "patch") void submitPatch(current.payload);
    else void submitPut(current.payload);
  };

  if (loadError) {
    return html`
      <div class="config-view">
        <div class="config-banner error">Failed to load config: ${loadError}</div>
      </div>
    `;
  }

  if (config === null) {
    return html`<div class="config-view"><p class="config-empty">Loading config…</p></div>`;
  }

  return html`
    <div class="config-view">
      <header class="config-header">
        <div>
          <p class="config-subtitle">
            The single source of truth for Omnesis settings, served from
            ${" "}<code>~/.config/omnesis/omnesis.json</code>. Edits made here,
            in the CLI, or by editing the file directly all converge —
            every writer goes through the same schema validation.
          </p>
        </div>
        <div class="config-version">version ${version}</div>
      </header>

      ${flashBanner}
      ${externalNotice && hasStagedEdits ? html`
        <div class="config-banner notice">
          The config changed elsewhere (CLI, file edit, or another tab) while
          you had unsaved edits. Your edits were kept — Save diffs them
          against the latest version, so review carefully before confirming.
        </div>
      ` : null}

      <div class="config-toolbar">
        <div class="config-toolbar-mode">
          <span class="segmented-row-label">Edit as</span>
          <${Segmented}
            options=${[
              { value: "structured", label: "Structured" },
              { value: "raw", label: "Raw JSON" },
            ]}
            value=${mode}
            onChange=${setMode}
          />
        </div>
        <div class="config-toolbar-actions">
          <span class="config-savebar-status">
            ${busy
              ? "Saving…"
              : pendingDiffs.length === 0
                ? (mode === "raw" && rawTextLocal !== null && !rawParse?.ok
                  ? "Staged raw edits need valid JSON before they can be reviewed."
                  : "No unsaved changes.")
                : `${pendingDiffs.length} unsaved change${pendingDiffs.length === 1 ? "" : "s"} — nothing is written until you Save and confirm.`}
          </span>
          <button type="button" class="btn-secondary" onClick=${discardDrafts} disabled=${busy || !hasStagedEdits}>Discard</button>
          <button type="button" class="btn-primary" onClick=${openReview} disabled=${saveDisabled}>Save</button>
        </div>
      </div>

      ${mode === "structured"
        ? html`<${StructuredForm}
            schema=${schema}
            config=${draft ?? config}
            onPatch=${stagePatch}
            busy=${busy}
            lastError=${status?.ok === false ? status.lastError : null}
            pushBasedSources=${pushBasedSources}
            serverErrors=${serverErrors}
            reconcileToken=${externalRevision}
            dirtyPaths=${dirtyPaths}
          />`
        : html`<${RawEditor}
            text=${rawDisplayText}
            onTextChange=${handleRawTextChange}
            busy=${busy}
            serverErrors=${serverErrors}
          />`}

      <${ConfirmModal}
        open=${!!review}
        title=${review ? `Review ${review.diffs.length} change${review.diffs.length === 1 ? "" : "s"} before saving` : ""}
        body=${review ? html`<div>
          ${review.stale ? html`<p class="config-banner notice">
            The config changed elsewhere while this review was open, so this
            diff is stale. Close it and Save again to re-review against the
            latest version before confirming.
          </p>` : null}
          <p>Red lines will be removed. Green lines will be added.</p>
          <${PrivacyPolicyDiff} before=${review.beforeText} after=${review.afterText} label="Config changes" />
        </div>` : null}
        confirmLabel="Confirm save"
        confirmDisabled=${busy || review?.stale}
        cancelDisabled=${busy}
        onCancel=${() => setReview(null)}
        onConfirm=${confirmReview}
      />
    </div>
  `;
}
