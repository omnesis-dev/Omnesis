// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  getRecordingRestoreReview,
  mayRequestRecordingReview,
  resumeRecordingRestoreReview,
} from "../lib/recording-restore-review-api.js";
import { navigate } from "../lib/router.js";
import { ConfirmModal } from "./confirm-modal.js";

const CHANGED = "omnesis:recording-restore-reviewed";
const SETTINGS = "/portal/settings/storage";
const MODELS = "/portal/settings/models/transcriber";
const CONFIG = "/portal/settings/config";
const DELETION =
  "Saved audio, including failed/old recordings, may be deleted immediately after resuming.";

function link(href, text) {
  return html`<a
    href=${href}
    onClick=${(event) => {
      event.preventDefault();
      navigate(href);
    }}
    >${text}</a
  >`;
}

function Choices({ value }) {
  return html`<dl>
    <dt>Saved audio</dt>
    <dd>
      ${value.keepAudioDays === 0 ? DELETION : `Saved audio older than ${value.keepAudioDays} days may be deleted after resuming, including failed or old recordings.`}
    </dd>
    <dt>Transcription model</dt>
    <dd>
      ${value.transcriberAssignment ?? "No transcription model assigned"}
      <p>${link(MODELS, "Choose or review transcription model")}</p>
    </dd>
    <dt>Speaker detection</dt>
    <dd>
      ${value.speakers === "local" ? "Local. Voice models may download if missing." : value.speakers === "off" ? "Off" : "Replay fixture"}
    </dd>
  </dl>`;
}

/** Protective review of existing restored work; this never enables recording capture or a Lab feature. */
export function RecordingRestoreReview({ variant = "notice", refreshKey = "" } = {}) {
  const enabled = mayRequestRecordingReview();
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [verified, setVerified] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const lifecycle = useRef(0);
  const reading = useRef(null);
  const mutation = useRef(null);
  const locked = useRef(false);
  const lastVersion = useRef(null);

  async function read() {
    const selected = ++generation.current;
    setVerified(false);
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    // Reads must also settle when a transport ignores cancellation or never replies.
    const cancelled = new Promise((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("Read stopped"), { name: "AbortError" })),
        { once: true },
      );
    });
    let expired = false;
    const deadline = setTimeout(() => {
      expired = true;
      controller.abort();
    }, 10000);
    try {
      const value = await Promise.race([
        getRecordingRestoreReview({ signal: controller.signal }),
        cancelled,
      ]);
      if (!mounted.current || selected !== generation.current || controller.signal.aborted)
        return null;
      if (lastVersion.current !== value.version) setConfirmed(false);
      lastVersion.current = value.version;
      setSnapshot(value);
      setVerified(true);
      setError(null);
      return value;
    } catch (cause) {
      if (
        mounted.current &&
        selected === generation.current &&
        (expired || cause?.name !== "AbortError")
      ) {
        setConfirmed(false);
        // No metadata is not proof of an unpaused queue. Do not promote a gated feature on 403/404.
        if (![401, 403, 404].includes(cause?.status))
          setError("The current restore review could not be checked. Try again.");
      }
      return null;
    } finally {
      clearTimeout(deadline);
      if (reading.current === controller) reading.current = null;
    }
  }

  useEffect(() => {
    mounted.current = true;
    lifecycle.current += 1;
    locked.current = false;
    setBusy(false);
    setChecking(false);
    if (!enabled)
      return () => {
        mounted.current = false;
      };
    const refresh = () => {
      if (!locked.current) void read();
    };
    const visible = () => {
      if (document.visibilityState !== "hidden") refresh();
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(CHANGED, refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false;
      lifecycle.current += 1;
      generation.current += 1;
      reading.current?.abort();
      mutation.current?.abort();
      mutation.current = null;
      locked.current = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener(CHANGED, refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [enabled, refreshKey]);

  async function review() {
    if (locked.current) return;
    const selectedLife = lifecycle.current;
    setConfirmed(false);
    setMessage(null);
    setChecking(true);
    const value = await read();
    if (mounted.current && lifecycle.current === selectedLife) {
      if (value?.reviewRequired) setOpen(true);
      setChecking(false);
    }
  }

  async function submit() {
    if (
      locked.current ||
      !verified ||
      !snapshot?.reviewRequired ||
      !confirmed ||
      (snapshot.hasPendingChunks && snapshot.transcriberAssignment === null)
    )
      return;
    locked.current = true;
    setBusy(true);
    setConfirmed(false);
    const selectedLife = lifecycle.current;
    const controller = new AbortController();
    mutation.current = controller;
    let failure = null;
    try {
      await resumeRecordingRestoreReview(snapshot.version, { signal: controller.signal });
    } catch (cause) {
      failure = cause;
    }
    // A lost acknowledgement or cancelled wait may still have committed. Read the actual policy.
    const active = () =>
      mounted.current && lifecycle.current === selectedLife && mutation.current === controller;
    const current = active() ? await read() : null;
    if (active()) {
      if (current?.reviewRequired === false) {
        setOpen(false);
        setMessage(
          "The restore pause is no longer active. Existing work follows the current settings.",
        );
        window.dispatchEvent(new Event(CHANGED));
      } else {
        setError(
          failure?.status === 409
            ? "Recording choices changed. Review the current choices and confirm again."
            : failure?.stepUp
              ? failure.message
              : "Resuming could not be confirmed. The restore pause has not been shown as removed. Check again before retrying.",
        );
      }
      setBusy(false);
    }
    if (mutation.current === controller) {
      locked.current = false;
      mutation.current = null;
    }
  }

  function cancel() {
    const wasWaiting = locked.current;
    mutation.current?.abort();
    mutation.current = null;
    reading.current?.abort();
    generation.current += 1;
    locked.current = false;
    setBusy(false);
    setChecking(false);
    setOpen(false);
    setConfirmed(false);
    if (wasWaiting) {
      setVerified(false);
      setError(
        "Waiting stopped. The current restore pause could not be confirmed. Check again before retrying.",
      );
    }
  }

  if (!enabled) return null;
  if (!snapshot?.reviewRequired)
    return variant === "settings" && message ? html`<p role="status">${message}</p>` : null;
  const needsModel = snapshot.hasPendingChunks && snapshot.transcriberAssignment === null;
  if (variant === "notice")
    return html`<aside class="privacy-banner warning" role="status" data-recording-restore-notice>
      <span
        ><strong>Restored recordings are paused.</strong> Automatic processing and audio deletion
        are paused while you review existing work. ${error && html`<span>${error}</span>`}</span
      >
      ${link(SETTINGS, "Review restored recordings")}
    </aside>`;

  return html`<section
    class="storage-panel"
    aria-labelledby="recording-restore-heading"
    data-recording-restore-review
  >
    <h3 id="recording-restore-heading">Restored recordings are paused</h3>
    <p>
      Existing audio and transcripts are preserved by this restore pause. Review automatic
      processing and deletion before removing it.
    </p>
    <${Choices} value=${snapshot} />
    ${needsModel && html`<p role="status">Pending audio needs a transcription model before this work can resume. ${link(MODELS, "Choose transcription model")}</p>`}
    <p>${link(CONFIG, "Change audio retention or speaker settings")}</p>
    ${error && html`<p class="storage-alert" role="alert">${error}</p>`}
    <button type="button" class="btn-secondary" disabled=${busy || checking} onClick=${review}>
      ${checking ? "Checking choices…" : "Review and resume"}
    </button>
    <p>
      <button type="button" class="btn-secondary" disabled=${busy} onClick=${read}>
        Check again
      </button>
    </p>
    <${ConfirmModal}
      open=${open}
      title="Resume restored recording work?"
      destructive
      confirmLabel=${busy ? "Checking…" : "Resume restored work"}
      cancelLabel=${busy ? "Stop waiting" : "Cancel"}
      confirmDisabled=${busy || !verified || !confirmed || needsModel}
      onConfirm=${submit}
      onCancel=${cancel}
      body=${html`<p>
          Automatic work will use these current choices. Existing transcripts are kept; the
          saved-audio policy can delete audio.
        </p>
        <${Choices} value=${snapshot} />
        <p>
          <button type="button" class="btn-secondary" disabled=${busy} onClick=${read}>
            Check choices again
          </button>
        </p>
        ${needsModel && html`<p role="alert">Choose a transcription model, then check these choices again before resuming.</p>`}
        <p>
          <label
            ><input
              type="checkbox"
              checked=${confirmed}
              disabled=${busy || !verified}
              onChange=${(event) => setConfirmed(event.target.checked)}
            />
            I reviewed these choices and the saved-audio deletion policy.</label
          >
        </p>
        ${error && html`<p class="storage-alert" role="alert">${error}</p>`}`}
    />
  </section>`;
}
