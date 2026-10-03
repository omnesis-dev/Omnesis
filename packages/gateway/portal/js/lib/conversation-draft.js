// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const prefix = "omnesis:conversation-draft:";
const pendingSubmissions = new Map();

export function readConversationDraft(key) {
  try {
    const value = JSON.parse(localStorage.getItem(prefix + key) || "null");
    return value && typeof value.text === "string" ? value : { text: "", command: null };
  } catch {
    return { text: "", command: null };
  }
}

/** Persist on input, before navigation or an asynchronous send can detach the composer. */
export function writeConversationDraft(key, text, command = null) {
  try {
    if (!text && !command) localStorage.removeItem(prefix + key);
    else localStorage.setItem(prefix + key, JSON.stringify({ text, command }));
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new window.CustomEvent("omnesis:conversation-draft", { detail: { key } }),
      );
    }
    return true;
  } catch {
    return false;
  }
}

/** An acknowledgment must not erase a newer draft typed after navigation. */
export function clearConversationDraft(key, expectedText, expectedCommand = null) {
  const current = readConversationDraft(key);
  if (current.text !== expectedText || (current.command ?? null) !== expectedCommand) return false;
  return writeConversationDraft(key, "");
}

export function readPendingSubmission(sessionId) {
  if (pendingSubmissions.has(sessionId)) return pendingSubmissions.get(sessionId);
  try {
    const saved = JSON.parse(localStorage.getItem(prefix + "pending:" + sessionId) || "null");
    return typeof saved?.submission?.text === "string" &&
      typeof saved.submission.clientMessageId === "string"
      ? saved.submission
      : null;
  } catch {
    return null;
  }
}

export function submissionForRetry(sessionId, text, options) {
  const key = prefix + "pending:" + sessionId;
  const saved = readPendingSubmission(sessionId);
  if (saved) {
    if (saved.text === text) return saved;
    throw new Error("Confirm the unacknowledged message before sending another one.");
  }
  const submission = { clientMessageId: crypto.randomUUID(), text, ...options };
  pendingSubmissions.set(sessionId, submission);
  try {
    localStorage.setItem(key, JSON.stringify({ submission }));
  } catch {
    /* Keep the visible draft. */
  }
  return submission;
}

export function clearPendingSubmission(sessionId, clientMessageId) {
  if (readPendingSubmission(sessionId)?.clientMessageId === clientMessageId)
    pendingSubmissions.set(sessionId, null);
  const key = prefix + "pending:" + sessionId;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (saved?.submission?.clientMessageId === clientMessageId) localStorage.removeItem(key);
  } catch {
    /* Storage can be unavailable in private browsing. */
  }
}

/** Move a saved answer from the separate clarification field into an empty composer. */
export function migrateClarificationDraft(sessionId, clarificationId) {
  const oldKey = `clarification:${clarificationId}`;
  const oldDraft = readConversationDraft(oldKey);
  const current = readConversationDraft(sessionId);
  if (!oldDraft.text || current.text || current.command) return false;
  if (!writeConversationDraft(sessionId, oldDraft.text, oldDraft.command)) return false;
  clearConversationDraft(oldKey, oldDraft.text, oldDraft.command);
  return true;
}
