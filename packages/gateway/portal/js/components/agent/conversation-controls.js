// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState } from "preact/hooks";
import {
  clearConversationDraft,
  readConversationDraft,
  writeConversationDraft,
} from "../../lib/conversation-draft.js";

function Clarification({ question, onAnswer }) {
  const draftKey = `clarification:${question.id}`;
  const [text, setText] = useState(() => readConversationDraft(draftKey).text);
  const [sending, setSending] = useState(false);
  async function answer(value) {
    if (sending || !value.trim()) return;
    setSending(true);
    try {
      if ((await onAnswer(value.trim(), { clarificationId: question.id })) !== false) {
        clearConversationDraft(draftKey, text);
      }
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
    <form
      onSubmit=${(event) => {
        event.preventDefault();
        answer(text);
      }}
    >
      <input
        aria-label="Your own answer"
        placeholder="Or write your own answer…"
        value=${text}
        disabled=${sending}
        onInput=${(event) => {
          setText(event.target.value);
          writeConversationDraft(draftKey, event.target.value);
        }}
      />
      <button type="submit" disabled=${sending || !text.trim()}>Answer</button>
    </form>
  </section>`;
}

export function ConversationControls({ controls, unconfirmed, onAnswer }) {
  if (!controls && !unconfirmed) return null;
  return html`<div class="agent-conversation-controls">
    ${unconfirmed
      ? html`<section class="agent-message-queue" aria-label="Unconfirmed message">
          <small>Not yet confirmed</small>
          <p>${unconfirmed.text}</p>
          <button type="button" onClick=${() => onAnswer(unconfirmed.text, unconfirmed)}>
            Retry original message
          </button>
        </section>`
      : null}
    ${controls?.pendingClarification
      ? html`<${Clarification}
          key=${controls?.pendingClarification.id}
          question=${controls?.pendingClarification}
          onAnswer=${onAnswer}
        />`
      : null}
    ${controls?.queuedMessages?.length
      ? html`<section class="agent-message-queue" aria-label="Queued messages">
          <small>Follow-ups</small>
          <ul>
            ${controls?.queuedMessages.map(
              (message) =>
                html`<li key=${message.id}>
                  <span>${message.text}</span
                  ><small
                    >${message.status === "failed" ? message.error || "Failed" : "Queued"}</small
                  >
                  ${message.status === "failed"
                    ? html`<button
                        type="button"
                        onClick=${() =>
                          onAnswer(message.text, {
                            mode: "queue",
                            ...(message.deepResearch === true ? { deepResearch: true } : {}),
                          })}
                      >
                        Retry
                      </button>`
                    : null}
                </li>`,
            )}
          </ul>
        </section>`
      : null}
  </div>`;
}
