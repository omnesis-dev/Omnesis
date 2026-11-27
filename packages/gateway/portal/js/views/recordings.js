// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Recordings (experimental) — the conversations a phone on the table recorded.
 *
 * The list says where each recording stands: still recording on the phone,
 * being transcribed, or done, with its chunks and any the transcriber gave up
 * on. One recording opens on its speakers, where the owner says who each one
 * is (themselves, a person, or just a name), and on its chunks, whose audio can
 * be played while the operator keeps it (`inference.recordings.keepAudioDays`;
 * by default it is deleted once transcribed). People who were there without
 * being told apart as a speaker are added under "Also present". Deleting a
 * recording deletes its chunks, any audio kept and its document.
 *
 * Suggestions — attendees and the title of a calendar event the recording
 * overlaps — are offered beside what they would change, and only applied
 * when the owner accepts one.
 *
 * An all-day recording the gateway split into conversations shows one section
 * per conversation — its title, transcript, speakers and suggestions — each
 * written as soon as the conversation ended.
 */

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import {
  addRecordingParticipant,
  deleteRecording,
  dismissRecordingSuggestion,
  getPeople,
  getRecordingChunkAudio,
  getRecordingChunks,
  getRecordingSpeakers,
  getRecordingSuggestions,
  listRecordings,
  removeRecordingParticipant,
  setRecordingConversationTitle,
  setRecordingSpeaker,
  setRecordingTitle,
} from "../api.js";
import { ConfirmModal } from "../components/confirm-modal.js";
import { Loading } from "../components/loading.js";
import { navigate } from "../lib/router.js";
import { formatPrivacyDate, formatPrivacyRelativeDate } from "./shared/privacy-vocabulary.js";

const LIST_HREF = "/portal/recordings";

const recordingHref = (id) => `${LIST_HREF}/${encodeURIComponent(id)}`;

const STATE_LABELS = { recording: "Recording", transcribing: "Transcribing", done: "Done" };

/** What a recording's state reads as. */
function recordingStateLabel(state) {
  return STATE_LABELS[state] ?? "Unknown";
}

/** Recorded time, to the minute once there is a minute: "40 s", "12 min", "1 h 05 min". */
export function formatRecordedTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0 s";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** Where a chunk starts in the recording, as the transcript stamps it: "00:02:00". */
export function formatOffset(ms) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A recording's chunks in one line: how many arrived, then only what is worth
 * a look — the ones still waiting and the ones that could not be transcribed.
 */
export function chunkSummary(recording) {
  const chunks = recording?.chunks ?? {};
  const received = chunks.received ?? 0;
  const declared = recording?.chunkCount;
  const parts = [
    Number.isInteger(declared) && declared > received
      ? `${received} of ${plural(declared, "chunk")}`
      : plural(received, "chunk"),
  ];
  if (chunks.pending > 0) parts.push(`${chunks.pending} waiting`);
  if (chunks.failed > 0) parts.push(`${chunks.failed} not transcribed`);
  return parts.join(" · ");
}

/** "2 of 3 speakers named", or null for a recording with no speakers told apart. */
export function speakerSummary(recording) {
  const speakers = recording?.speakers ?? 0;
  if (speakers <= 0) return null;
  return `${recording.namedSpeakers ?? 0} of ${plural(speakers, "speaker")} named`;
}

const CHUNK_STATUS_LABELS = {
  pending: "Waiting for the transcriber",
  transcribed: "Transcribed",
  failed: "Not transcribed",
  silent: "Silent",
};

/** What a chunk's status reads as. */
function chunkStatusLabel(status) {
  return CHUNK_STATUS_LABELS[status] ?? "Unknown";
}

function errorText(err) {
  return err?.serverMessage ?? err?.message ?? String(err);
}

function stateClass(state) {
  if (state === "done") return "success";
  if (state === "transcribing") return "warning";
  return "muted";
}

function BackLink() {
  return html`<a
    class="doc-back"
    href=${LIST_HREF}
    onClick=${(event) => {
      event.preventDefault();
      navigate(LIST_HREF);
    }}
  >← Recordings</a>`;
}

function Unavailable() {
  return html`<div class="privacy-empty-state">
    <strong>Recordings are off</strong>
    <span>Turn on Recordings in Settings → Omnesis Lab to record conversations.</span>
  </div>`;
}

// ── list ──────────────────────────────────────────────────────────────

function RecordingList({ recordings }) {
  if (recordings.length === 0) {
    return html`<div class="privacy-empty-state">
      <strong>No recorded conversations yet</strong>
      <span>
        Record one with the Omnesis app on Android: Recordings in its menu, or the Record
        conversation tile in Quick Settings.
      </span>
    </div>`;
  }
  return html`<ul class="privacy-conversation-list recordings-list">
    ${recordings.map((recording) => {
      const href = recordingHref(recording.id);
      const speakers = speakerSummary(recording);
      const conversations = recording.conversations?.length ?? 0;
      return html`<li key=${recording.id}>
        <a
          class="privacy-conversation-row"
          href=${href}
          onClick=${(event) => {
            event.preventDefault();
            navigate(href);
          }}
        >
          <span class="privacy-conversation-main">
            <strong>${recording.title}</strong>
            <span>${formatRecordedTime(recording.durationMs)} · ${chunkSummary(recording)}</span>
            ${speakers || conversations > 0
              ? html`<span class="watch-row-indicators">
                  ${conversations > 0
                    ? html`<span class="watch-indicator">${plural(conversations, "conversation")}</span>`
                    : null}
                  ${speakers ? html`<span class="watch-indicator">${speakers}</span>` : null}
                </span>`
              : null}
          </span>
          <span class="privacy-conversation-meta">
            ${formatPrivacyRelativeDate(Date.parse(recording.startedAt))}
          </span>
          <span class=${`privacy-item-status ${stateClass(recording.state)}`}>
            ${recordingStateLabel(recording.state)}
          </span>
        </a>
      </li>`;
    })}
  </ul>`;
}

function RecordingsDashboard() {
  const [recordings, setRecordings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    listRecordings()
      .then((payload) => {
        if (!live) return;
        setRecordings(Array.isArray(payload?.recordings) ? payload.recordings : []);
      })
      .catch((err) => {
        if (!live) return;
        if (err?.status === 404) setUnavailable(true);
        else setError(errorText(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  return html`<div class="privacy-view">
    <header class="privacy-page-header">
      <div>
        <h1>Recordings</h1>
        <span class="experimental-tag">Experimental</span>
      </div>
    </header>
    ${error
      ? html`<div class="privacy-banner error" role="alert">Failed to load recordings: ${error}</div>`
      : null}
    ${loading
      ? html`<${Loading} label="Loading recordings…" />`
      : unavailable
        ? html`<${Unavailable} />`
        : error
          ? null
          : html`<${RecordingList} recordings=${recordings} />`}
  </div>`;
}

// ── speakers ──────────────────────────────────────────────────────────

/**
 * Pick a person by name. Searches as the owner types; a click on a match is
 * the choice.
 */
function PersonSearch({ onPick, onCancel, disabled }) {
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState([]);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    const q = query.trim();
    if (!q) {
      setPeople([]);
      return undefined;
    }
    const timer = setTimeout(() => {
      getPeople(q, 8)
        .then(({ people: found }) => {
          if (generation.current === current) setPeople(found ?? []);
        })
        .catch(() => {
          if (generation.current === current) setPeople([]);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  return html`<div class="recording-speaker-picker">
    <input
      type="search"
      class="recording-speaker-input"
      placeholder="Search people"
      aria-label="Search people"
      value=${query}
      disabled=${disabled}
      onInput=${(event) => setQuery(event.currentTarget.value)}
      onKeyDown=${(event) => {
        if (event.key === "Escape") onCancel();
      }}
    />
    ${people.length > 0
      ? html`<ul class="recording-speaker-matches">
          ${people.map(
            (person) => html`<li key=${person.id}>
              <button
                type="button"
                class="btn-tiny"
                disabled=${disabled}
                onClick=${() => onPick(person)}
              >${person.canonicalName || person.id}</button>
            </li>`,
          )}
        </ul>`
      : query.trim()
        ? html`<span class="recording-speaker-hint">No one by that name yet.</span>`
        : null}
    <button type="button" class="btn-tiny" onClick=${onCancel}>Cancel</button>
  </div>`;
}

function NameForm({ initial, onSave, onCancel, disabled }) {
  const [name, setName] = useState(initial ?? "");
  return html`<form
    class="recording-speaker-picker"
    onSubmit=${(event) => {
      event.preventDefault();
      if (name.trim()) onSave(name.trim());
    }}
  >
    <input
      type="text"
      class="recording-speaker-input"
      placeholder="Name"
      aria-label="Name"
      maxlength="120"
      value=${name}
      disabled=${disabled}
      onInput=${(event) => setName(event.currentTarget.value)}
      onKeyDown=${(event) => {
        if (event.key === "Escape") onCancel();
      }}
    />
    <button type="submit" class="btn-tiny" disabled=${disabled || !name.trim()}>Save</button>
    <button type="button" class="btn-tiny" onClick=${onCancel}>Cancel</button>
  </form>`;
}

/** Why a person is suggested, in a few words. */
function suggestionReason(suggestion) {
  return `On your calendar: ${suggestion.evidence}`;
}

/**
 * The people suggested for one speaker: each can be accepted, which names the
 * speaker, or dismissed, which stops it being offered.
 */
function SpeakerSuggestions({ suggestions, disabled, onAccept, onDismiss }) {
  if (suggestions.length === 0) return null;
  return html`<div class="recording-suggestions">
    <span class="recording-suggestions-label">Suggested</span>
    <ul class="recording-suggestion-list">
      ${suggestions.map(
        (suggestion) => html`<li key=${suggestion.key} class="recording-suggestion" data-key=${suggestion.key}>
          <button
            type="button"
            class="btn-tiny recording-suggestion-accept"
            disabled=${disabled}
            onClick=${() => onAccept(suggestion)}
          >${suggestion.name}</button>
          <span class="recording-suggestion-why">${suggestionReason(suggestion)}</span>
          <button
            type="button"
            class="btn-tiny recording-suggestion-dismiss"
            aria-label=${`Dismiss ${suggestion.name}`}
            title="Dismiss"
            disabled=${disabled}
            onClick=${() => onDismiss(suggestion)}
          >×</button>
        </li>`,
      )}
    </ul>
  </div>`;
}

function SpeakerRow({ recordingId, speaker, suggestions = [], onSpeakers, onDismiss }) {
  // null, "person" or "name": which picker is open.
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const mapped = speaker.isSelf || speaker.personId !== null || speaker.name !== null;

  async function apply(mapping) {
    setBusy(true);
    setError(null);
    try {
      const payload = await setRecordingSpeaker(recordingId, speaker.speaker, mapping);
      setMode(null);
      onSpeakers(Array.isArray(payload?.speakers) ? payload.speakers : null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const who = speaker.isSelf
    ? "You"
    : speaker.personId
      ? `${speaker.name ?? speaker.personId}, from People`
      : speaker.name
        ? speaker.name
        : "Not named yet";

  return html`<li class="recording-speaker" data-speaker=${speaker.speaker}>
    <div class="recording-speaker-head">
      <strong>Speaker ${speaker.speaker}</strong>
      <span class=${`recording-speaker-who${mapped ? "" : " is-unnamed"}`}>${who}</span>
      <span class="recording-speaker-talk">Spoke for ${formatRecordedTime(speaker.talkMs)}</span>
    </div>
    ${speaker.samples?.length
      ? html`<ul class="recording-speaker-samples">
          ${speaker.samples.map((sample, i) => html`<li key=${i}>“${sample}”</li>`)}
        </ul>`
      : null}
    ${mapped || mode !== null
      ? null
      : html`<${SpeakerSuggestions}
          suggestions=${suggestions}
          disabled=${busy}
          onAccept=${(s) => apply({ personId: s.personId })}
          onDismiss=${async (s) => {
            setBusy(true);
            setError(null);
            try {
              await onDismiss(s);
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        />`}
    ${mode === "person"
      ? html`<${PersonSearch}
          disabled=${busy}
          onPick=${(person) => apply({ personId: person.id })}
          onCancel=${() => setMode(null)}
        />`
      : mode === "name"
        ? html`<${NameForm}
            initial=${speaker.personId ? "" : speaker.name}
            disabled=${busy}
            onSave=${(name) => apply({ name })}
            onCancel=${() => setMode(null)}
          />`
        : html`<div class="recording-speaker-actions">
            ${speaker.isSelf
              ? null
              : html`<button type="button" class="btn-tiny" disabled=${busy} onClick=${() => apply({ self: true })}>
                  This is me
                </button>`}
            <button type="button" class="btn-tiny" disabled=${busy} onClick=${() => setMode("person")}>
              Choose a person…
            </button>
            <button type="button" class="btn-tiny" disabled=${busy} onClick=${() => setMode("name")}>
              Type a name…
            </button>
            ${mapped
              ? html`<button type="button" class="btn-tiny" disabled=${busy} onClick=${() => apply({ clear: true })}>
                  Clear
                </button>`
              : null}
          </div>`}
    ${error ? html`<div class="privacy-banner error" role="alert">${error}</div>` : null}
  </li>`;
}

/**
 * People who were present but are not one of the speakers: added from People
 * or by name, removed with ×. Calendar attendees not mapped to a speaker are
 * offered here too.
 */
function AlsoPresent({ recordingId, participants, suggestions, onParticipants, onDismiss }) {
  // null, "person" or "name": which picker is open.
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function act(action) {
    setBusy(true);
    setError(null);
    try {
      const payload = await action();
      setMode(null);
      if (Array.isArray(payload?.participants)) onParticipants(payload.participants);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  const add = (participant) => act(() => addRecordingParticipant(recordingId, participant));

  return html`<div class="recording-present">
    ${participants.length > 0
      ? html`<ul class="recording-participants">
          ${participants.map(
            (p) => html`<li key=${p.key} class="recording-participant" data-key=${p.key}>
              <span>${p.name ?? "Someone from People"}${p.personId ? html`<span class="recording-participant-from">, from People</span>` : null}</span>
              <button
                type="button"
                class="btn-tiny recording-participant-remove"
                aria-label=${`Remove ${p.name ?? "this person"}`}
                title="Remove"
                disabled=${busy}
                onClick=${() => act(() => removeRecordingParticipant(recordingId, p.key))}
              >×</button>
            </li>`,
          )}
        </ul>`
      : html`<p class="privacy-empty">No one added. Add people who were there but did not speak, or were not told apart.</p>`}
    ${mode === null
      ? html`<${SpeakerSuggestions}
          suggestions=${suggestions}
          disabled=${busy}
          onAccept=${(s) => add(s.personId ? { personId: s.personId } : { name: s.name })}
          onDismiss=${async (s) => {
            setBusy(true);
            setError(null);
            try {
              await onDismiss(s);
            } catch (err) {
              setError(errorText(err));
            } finally {
              setBusy(false);
            }
          }}
        />`
      : null}
    ${mode === "person"
      ? html`<${PersonSearch}
          disabled=${busy}
          onPick=${(person) => add({ personId: person.id })}
          onCancel=${() => setMode(null)}
        />`
      : mode === "name"
        ? html`<${NameForm} initial="" disabled=${busy} onSave=${(name) => add({ name })} onCancel=${() => setMode(null)} />`
        : html`<div class="recording-speaker-actions">
            <button type="button" class="btn-tiny" disabled=${busy} onClick=${() => setMode("person")}>
              Add a person…
            </button>
            <button type="button" class="btn-tiny" disabled=${busy} onClick=${() => setMode("name")}>
              Type a name…
            </button>
          </div>`}
    ${error ? html`<div class="privacy-banner error" role="alert">${error}</div>` : null}
  </div>`;
}

/** The calendar's title for a recording, offered under its own. */
function TitleSuggestion({ suggestion, onAccept, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function act(action) {
    setBusy(true);
    setError(null);
    try {
      await action(suggestion);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }
  return html`<div class="recording-title-suggestion" data-key=${suggestion.key}>
    <span>Your calendar had <strong>${suggestion.title}</strong> at this time.</span>
    <button type="button" class="btn-tiny" disabled=${busy} onClick=${() => act(onAccept)}>
      Use this title
    </button>
    <button type="button" class="btn-tiny" disabled=${busy} onClick=${() => act(onDismiss)}>
      Dismiss
    </button>
    ${error ? html`<span class="recording-chunk-error" role="alert">${error}</span>` : null}
  </div>`;
}

/** The link to a recording's, or a conversation's, written transcript. */
function TranscriptLink({ href }) {
  return html`<a
    class="btn-secondary"
    href=${href}
    onClick=${(event) => {
      event.preventDefault();
      navigate(href);
    }}
  >Open the transcript</a>`;
}

/** Speakers with who each one is, and the people suggested for the unnamed ones. */
function SpeakerList({ recordingId, speakers, suggestions, empty, onDismiss, onSpeakers }) {
  if (speakers.length === 0) return html`<p class="privacy-empty">${empty}</p>`;
  // Calendar attendees are offered to every unnamed speaker in this conversation.
  const people = suggestions.filter((s) => s.kind === "person");
  return html`<ul class="recording-speakers">
    ${speakers.map(
      (speaker) => html`<${SpeakerRow}
        key=${speaker.speaker}
        recordingId=${recordingId}
        speaker=${speaker}
        suggestions=${people}
        onDismiss=${onDismiss}
        onSpeakers=${onSpeakers}
      />`,
    )}
  </ul>`;
}

/** "10:00 · 12 min" in the viewer's time: when a conversation started, and how long it went on. */
export function conversationSpan(startedAt, endedAt) {
  const start = Date.parse(startedAt);
  const clock = new Date(start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${clock} · ${formatRecordedTime(Date.parse(endedAt) - start)}`;
}

/** One conversation of a split all-day recording: its title, transcript and speakers. */
function ConversationSection({
  recordingId,
  conversation,
  speakers,
  suggestions,
  onDismiss,
  onSpeakers,
  onSummary,
}) {
  const titleSuggestion = conversation.titled
    ? null
    : (suggestions.find((s) => s.kind === "title") ?? null);
  const href = conversation.documentId
    ? `/portal/doc/${encodeURIComponent(conversation.documentId)}`
    : null;
  return html`<section class="privacy-section recording-conversation" data-conversation=${conversation.n}>
    <div class="privacy-section-head">
      <h2>${conversation.title}</h2>
      <span class="recording-conversation-span">
        ${conversationSpan(conversation.startedAt, conversation.endedAt)}
      </span>
    </div>
    ${titleSuggestion
      ? html`<${TitleSuggestion}
          suggestion=${titleSuggestion}
          onAccept=${async (s) => {
            onSummary(await setRecordingConversationTitle(recordingId, conversation.n, s.title));
          }}
          onDismiss=${onDismiss}
        />`
      : null}
    ${href ? html`<div class="recording-actions"><${TranscriptLink} href=${href} /></div>` : null}
    <${SpeakerList}
      recordingId=${recordingId}
      speakers=${speakers}
      suggestions=${suggestions}
      empty="No speakers were told apart in this conversation."
      onDismiss=${onDismiss}
      onSpeakers=${onSpeakers}
    />
  </section>`;
}

// ── chunks ────────────────────────────────────────────────────────────

/**
 * Play one chunk's kept audio. Fetched on demand, with the portal's session,
 * into an object URL the player reads; released when the row goes.
 */
function ChunkAudio({ recordingId, seq }) {
  const [url, setUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  if (url) return html`<audio class="recording-chunk-audio" controls autoplay src=${url}></audio>`;
  return html`<span class="recording-chunk-play">
    <button
      type="button"
      class="btn-tiny"
      disabled=${busy}
      onClick=${async () => {
        setBusy(true);
        setError(null);
        try {
          const blob = await getRecordingChunkAudio(recordingId, seq);
          setUrl(URL.createObjectURL(blob));
        } catch (err) {
          setError(err?.status === 404 ? "The audio is gone." : errorText(err));
        } finally {
          setBusy(false);
        }
      }}
    >${busy ? "Loading…" : "Play"}</button>
    ${error ? html`<span class="recording-chunk-error" role="alert">${error}</span>` : null}
  </span>`;
}

function ChunkList({ recordingId, recording, chunks }) {
  if (chunks.length === 0) {
    return html`<p class="privacy-empty">No chunk has arrived yet.</p>`;
  }
  const start = Date.parse(recording.startedAt);
  return html`<ol class="recording-chunks">
    ${chunks.map((chunk) => {
      const offset = Date.parse(chunk.startedAt) - start;
      return html`<li key=${chunk.seq} class=${`recording-chunk is-${chunk.status}`}>
        <span class="recording-chunk-at">${formatOffset(offset)}</span>
        <span class="recording-chunk-length">${formatRecordedTime(chunk.durationMs)}</span>
        <span class="recording-chunk-status">
          ${chunkStatusLabel(chunk.status)}${chunk.interrupted ? " · interrupted" : ""}
        </span>
        ${chunk.audio && chunk.status !== "pending"
          ? html`<span class="recording-chunk-kept">
              <${ChunkAudio} recordingId=${recordingId} seq=${chunk.seq} />
              ${chunk.audioDeletedAt
                ? html`<span class="recording-chunk-until">
                    Audio kept until ${formatPrivacyDate(Date.parse(chunk.audioDeletedAt))}
                  </span>`
                : null}
            </span>`
          : null}
      </li>`;
    })}
  </ol>`;
}

// ── one recording ─────────────────────────────────────────────────────

/** A recording's suggestions; none when they cannot be read, which never blocks the page. */
async function loadSuggestions(id, conversation) {
  try {
    const payload = await getRecordingSuggestions(id, conversation);
    return Array.isArray(payload?.suggestions) ? payload.suggestions : [];
  } catch {
    return [];
  }
}

/**
 * A recording's suggestions by section: `session` for a recording that is
 * one conversation, `c<n>` for each conversation of a split one.
 */
async function loadAllSuggestions(id, recording) {
  const conversations = recording?.conversations ?? [];
  if (conversations.length === 0) return { session: await loadSuggestions(id) };
  const lists = await Promise.all(conversations.map((c) => loadSuggestions(id, c.n)));
  return Object.fromEntries(conversations.map((c, i) => [`c${c.n}`, lists[i]]));
}

/** One recording, with its speakers, chunks and suggestions. */
async function loadRecording(id) {
  try {
    const [detail, speakers] = await Promise.all([getRecordingChunks(id), getRecordingSpeakers(id)]);
    return {
      kind: "found",
      recording: detail.recording,
      chunks: Array.isArray(detail.chunks) ? detail.chunks : [],
      speakers: Array.isArray(speakers?.speakers) ? speakers.speakers : [],
      participants: Array.isArray(speakers?.participants) ? speakers.participants : [],
      suggestions: await loadAllSuggestions(id, detail.recording),
    };
  } catch (err) {
    if (err?.status === 404) return { kind: "missing" };
    return { kind: "error", error: errorText(err) };
  }
}

function RecordingDetail({ id }) {
  const [loaded, setLoaded] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  useEffect(() => {
    let live = true;
    loadRecording(id).then((result) => {
      if (live) setLoaded(result);
    });
    return () => {
      live = false;
    };
  }, [id]);

  if (loaded === null) {
    return html`<div class="privacy-view"><${BackLink} /><${Loading} label="Loading recording…" /></div>`;
  }
  if (loaded.kind === "missing") {
    return html`<div class="privacy-view">
      <${BackLink} />
      <div class="privacy-empty-state">
        <strong>No recording here</strong>
        <span>It was deleted, or this gateway never received it.</span>
      </div>
    </div>`;
  }
  if (loaded.kind === "error") {
    return html`<div class="privacy-view">
      <${BackLink} />
      <div class="privacy-banner error" role="alert">Failed to load the recording: ${loaded.error}</div>
    </div>`;
  }

  const { recording, chunks, speakers, participants, suggestions } = loaded;
  const conversations = recording.conversations ?? [];
  const sessionSuggestions = suggestions.session ?? [];
  const titleSuggestion = sessionSuggestions.find((s) => s.kind === "title") ?? null;
  // The people present without a turn are the whole recording's, so a split
  // recording offers each calendar attendee once, whichever conversation
  // they were suggested for.
  const presentSuggestions = [];
  const offeredPeople = new Set();
  for (const list of Object.values(suggestions)) {
    for (const s of list) {
      if (s.kind !== "person" || offeredPeople.has(s.personId)) continue;
      offeredPeople.add(s.personId);
      presentSuggestions.push(s);
    }
  }

  // Accepting or dismissing one suggestion can settle others (a person named
  // for one speaker is no longer offered for the rest), so they are read again.
  function update(patch) {
    setLoaded((current) =>
      current?.kind === "found"
        ? { ...current, ...patch, recording: { ...current.recording, ...patch.recording } }
        : current,
    );
  }

  async function refreshSuggestions(current = recording) {
    update({ suggestions: await loadAllSuggestions(id, current) });
  }

  async function dismiss(suggestion) {
    await dismissRecordingSuggestion(id, suggestion.key);
    await refreshSuggestions();
  }

  function onSpeakers(next) {
    if (!next) return;
    const named = next.filter((s) => s.isSelf || s.personId || s.name).length;
    update({ speakers: next, recording: { namedSpeakers: named } });
    refreshSuggestions();
  }

  const documentHref = recording.documentId && conversations.length === 0
    ? `/portal/doc/${encodeURIComponent(recording.documentId)}`
    : null;

  async function remove() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteRecording(id);
      navigate(LIST_HREF);
    } catch (err) {
      setDeleteError(errorText(err));
      setDeleting(false);
      setConfirming(false);
    }
  }

  return html`<div class="privacy-view recording-detail">
    <${BackLink} />
    <header class="privacy-detail-header">
      <div>
        <h1>${recording.title}</h1>
        <p>
          Started ${formatPrivacyDate(Date.parse(recording.startedAt))} ·
          ${" "}${formatRecordedTime(recording.durationMs)} · ${chunkSummary(recording)}
        </p>
      </div>
      <span class=${`privacy-item-status ${stateClass(recording.state)}`}>
        ${recordingStateLabel(recording.state)}
      </span>
    </header>
    ${titleSuggestion && conversations.length === 0
      ? html`<${TitleSuggestion}
          suggestion=${titleSuggestion}
          onAccept=${async (s) => {
            const summary = await setRecordingTitle(id, s.title);
            update({ recording: summary ?? { title: s.title } });
            await refreshSuggestions();
          }}
          onDismiss=${dismiss}
        />`
      : null}
    <div class="recording-actions">
      ${documentHref ? html`<${TranscriptLink} href=${documentHref} />` : null}
      <button type="button" class="btn-secondary danger" disabled=${deleting} onClick=${() => setConfirming(true)}>
        Delete recording
      </button>
    </div>
    ${deleteError
      ? html`<div class="privacy-banner error" role="alert">Failed to delete: ${deleteError}</div>`
      : null}

    ${conversations.length === 0
      ? html`<section class="privacy-section">
          <div class="privacy-section-head">
            <h2>Speakers</h2>
          </div>
          <${SpeakerList}
            recordingId=${id}
            speakers=${speakers}
            suggestions=${sessionSuggestions}
            empty=${recording.state === "done"
              ? "No speakers were told apart in this recording."
              : "Speakers are told apart once the recording is transcribed."}
            onDismiss=${dismiss}
            onSpeakers=${onSpeakers}
          />
        </section>`
      : html`${conversations.map(
            (conversation) => html`<${ConversationSection}
              key=${conversation.n}
              recordingId=${id}
              conversation=${conversation}
              speakers=${speakers.filter((s) => s.conversation === conversation.n)}
              suggestions=${suggestions[`c${conversation.n}`] ?? []}
              onDismiss=${dismiss}
              onSpeakers=${onSpeakers}
              onSummary=${async (summary) => {
                update({ recording: summary });
                await refreshSuggestions({ ...recording, ...summary });
              }}
            />`,
          )}
          ${recording.state === "recording"
            ? html`<p class="privacy-empty recording-conversation-pending">
                The conversation going on now is written once it has been quiet for a while.
              </p>`
            : null}`}

    <section class="privacy-section">
      <div class="privacy-section-head">
        <h2>Also present</h2>
      </div>
      <${AlsoPresent}
        recordingId=${id}
        participants=${participants}
        suggestions=${presentSuggestions}
        onDismiss=${dismiss}
        onParticipants=${(next) => {
          update({ participants: next });
          refreshSuggestions();
        }}
      />
    </section>

    <section class="privacy-section">
      <div class="privacy-section-head">
        <h2>Chunks</h2>
      </div>
      <${ChunkList} recordingId=${id} recording=${recording} chunks=${chunks} />
    </section>

    <${ConfirmModal}
      open=${confirming}
      title="Delete this recording?"
      body="Its transcript, its chunks and any audio kept are deleted. This cannot be undone."
      confirmLabel=${deleting ? "Deleting…" : "Delete"}
      destructive=${true}
      confirmDisabled=${deleting}
      cancelDisabled=${deleting}
      onConfirm=${remove}
      onCancel=${() => setConfirming(false)}
    />
  </div>`;
}

export function RecordingsView({ recordingId = null }) {
  if (recordingId) return html`<${RecordingDetail} key=${recordingId} id=${recordingId} />`;
  return html`<${RecordingsDashboard} />`;
}
