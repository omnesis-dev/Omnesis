// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The note agent's reading of a Tell Omnesis note, as the note list shows
 * it. A listed note may carry `agent: { state, receipt }`: pending and
 * running read as "Omnesis is reading this…", done shows the receipt text
 * and each task change it made (each undoable by its ledger sequence),
 * failed says so quietly, and skipped shows nothing. Pure helpers; the
 * rendering lives in `components/note-agent-receipt.js`.
 */

/** How often the visible notes are re-read while the agent is still reading one. */
export const NOTE_AGENT_REFRESH_MS = 5_000;

/** Whether the agent has yet to settle on this note. */
export function noteAgentPending(agent) {
  return agent?.state === "pending" || agent?.state === "running";
}

/**
 * What a note's receipt line shows: `null` for nothing, or
 * `{ kind: "reading" | "receipt" | "failed", text, changes }`.
 */
export function noteAgentDisplay(agent) {
  if (!agent) return null;
  switch (agent.state) {
    case "pending":
    case "running":
      return { kind: "reading", text: "Omnesis is reading this…", changes: [] };
    case "failed":
      return { kind: "failed", text: "Omnesis couldn't act on this note.", changes: [] };
    case "done": {
      const text = (agent.receipt?.text ?? "").trim();
      const changes = (agent.receipt?.changes ?? []).filter((change) => change?.text);
      if (!text && changes.length === 0) return null;
      return { kind: "receipt", text, changes };
    }
    default:
      return null;
  }
}

/** Where a change's task opens; null for a change that names no task. */
export function noteChangeHref(change) {
  return change?.taskId ? "/portal/tasks" : null;
}

/** One sentence for a failed undo of a note's change. */
export function noteUndoErrorMessage(err) {
  if (err?.status === 409) {
    return "A later change to this task has to be undone first.";
  }
  if (err?.status === 404) return "That task no longer exists.";
  return "Couldn't undo that change — try again.";
}

/** Whether `/status` says a Tell Omnesis note is read by an agent that acts on it. */
export function noteAgentActive(status) {
  return status?.tasks?.noteAgent === true;
}

/** The config change that switches the note agent on or off. */
export function noteAgentSettingPatch(on) {
  return { agent: { noteAgent: on === true } };
}

/**
 * Whether a re-read copy of a note carries news for the list: its agent
 * state or receipt changed, or its gateway transcript arrived.
 */
export function noteRefreshChanged(current, fresh) {
  if (!current || !fresh) return false;
  if ((current.transcription ?? null) !== (fresh.transcription ?? null)) return true;
  return JSON.stringify(current.agent ?? null) !== JSON.stringify(fresh.agent ?? null);
}
