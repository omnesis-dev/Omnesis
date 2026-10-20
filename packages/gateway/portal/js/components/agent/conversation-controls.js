// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useRef, useState } from "preact/hooks";
import { MessageActions } from "./message-actions.js";

function Clarification({ question, onAnswer }) {
  const [sending, setSending] = useState(false);
  async function answer(value) {
    if (sending || !value.trim()) return;
    setSending(true);
    try {
      await onAnswer(value.trim(), { clarificationId: question.id });
    } finally {
      setSending(false);
    }
  }
  return html`<section class="agent-clarification" aria-label="Clarification question">
    <p>${question.question}</p>
    <div class="agent-clarification-choices">
      ${question.choices.map(
        (choice) =>
          html`<button type="button" disabled=${sending} onClick=${() => answer(choice.label)}>
            <strong>${choice.label}</strong>
            ${choice.description ? html`<span>${choice.description}</span>` : null}
          </button>`,
      )}
    </div>
  </section>`;
}

export function ConversationControls({ controls, unconfirmed, onAnswer, onSendNow }) {
  const [sendingNow, setSendingNow] = useState(false);
  const sendingNowRef = useRef(false);
  async function sendNow(group) {
    if (sendingNowRef.current) return;
    sendingNowRef.current = true;
    setSendingNow(true);
    try {
      await onSendNow(group.map((message) => message.id));
    } finally {
      sendingNowRef.current = false;
      setSendingNow(false);
    }
  }
  const queued = controls?.queuedMessages?.filter((message) => message.status === "queued") ?? [];
  const failed = controls?.queuedMessages?.filter((message) => message.status === "failed") ?? [];
  const groups = controls?.capabilities?.coalescedQueue
    ? queued.length
      ? [queued]
      : []
    : queued.map((message) => [message]);
  if (!controls && !unconfirmed) return null;
  return html`<div class="agent-conversation-controls">
    ${unconfirmed
      ? html`<${MessageActions} text=${unconfirmed.text}><section class="agent-message-queue" aria-label="Unconfirmed message">
          <small>Not yet confirmed</small>
          <p>${unconfirmed.text}</p>
          <button type="button" onClick=${() => onAnswer(unconfirmed.text, unconfirmed)}>
            Retry original message
          </button>
        </section></${MessageActions}>`
      : null}
    ${controls?.pendingClarification
      ? html`<${Clarification}
          key=${controls?.pendingClarification.id}
          question=${controls?.pendingClarification}
          onAnswer=${onAnswer}
        />`
      : null}
    ${groups.map((group) => {
      const queuedText = group.map((message) => message.text).join("\n\n");
      const canSendNow = controls?.capabilities?.queueSendNow && onSendNow;
      return html`<${MessageActions} text=${queuedText} action=${canSendNow
        ? { label: "Send now", disabled: sendingNow, onSelect: () => sendNow(group) }
        : null}>
      <div class="agent-msg agent-msg-user agent-queued-message" aria-label="Queued messages">
        <div class="agent-msg-body">${queuedText}</div>
        <small>Queued${canSendNow ? html` – <button class="agent-queued-send-now" type="button" disabled=${sendingNow} onClick=${() => sendNow(group)}>send now</button>` : null}</small>
      </div>
    </${MessageActions}>`;
    })}
    ${failed.map(
      (message) =>
        html`<${MessageActions} text=${message.text} key=${message.id}><section class="agent-message-queue" aria-label="Failed message">
          <p>${message.text}</p>
          <small>${message.error || "Failed"}</small>
          <button
            type="button"
            onClick=${() =>
              onAnswer(message.text, {
                mode: "queue",
                ...(message.deepResearch === true ? { deepResearch: true } : {}),
              })}
          >
            Retry
          </button>
        </section></${MessageActions}>`,
    )}
  </div>`;
}
