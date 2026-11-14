// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// "Who can read this?": for one document, every access level with the
// agents connected to it, and whether Answer and Direct can read the
// document there, with the gateway's reason. The gateway runs the same check
// an agent's read runs; this page only lays the answer out.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getDocumentAccess } from "../api.js";
import { navigate } from "../lib/router.js";
import { sourceIcon } from "../lib/format.js";
import { sourceAccountOf } from "../lib/source-id.js";
import { CapabilityPill } from "../components/access-pills.js";

/** The two ways an agent reads, in the order the page lists them. */
const VERDICTS = ["answer", "direct"];

function VerdictMark({ readable }) {
  return html`<span class=${`doc-access-mark${readable ? " is-readable" : ""}`}>
    <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      ${readable ? html`<path d="M3 8.5l3.2 3L13 4.5" />` : html`<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />`}
    </svg>
    ${readable ? "Can read" : "Can’t read"}
  </span>`;
}

/** One agent on a level: a connection by its name, an integration with its pill. */
function Agent({ agent }) {
  return html`<li class="doc-access-agent">
    <span>${agent.name}</span>
    ${agent.kind === "device" ? html`<span class="portal-pill">Integration</span>` : null}
  </li>`;
}

/**
 * One level's card. A capability's pill is coloured when the level grants it
 * and muted when it does not, as everywhere else; whether this document is
 * readable is said by the mark and its words beside it.
 */
function LevelVerdicts({ level }) {
  const headingId = `doc-access-level-${level.id}`;
  return html`<section class="doc-access-level" aria-labelledby=${headingId}>
    <header>
      <h2 id=${headingId}>${level.name}</h2>
      ${level.agents?.length
        ? html`<ul class="doc-access-agents" aria-label=${`Agents using ${level.name}`}>
            ${level.agents.map((agent) => html`<${Agent} key=${agent.id} agent=${agent} />`)}
          </ul>`
        : html`<p class="access-level-empty">No connections</p>`}
    </header>
    <dl class="doc-access-verdicts">
      ${VERDICTS.map((capability) => {
        const verdict = level[capability] ?? { readable: false, text: "" };
        return html`<div class="doc-access-verdict" key=${capability}>
          <dt>
            <${CapabilityPill}
              capability=${capability}
              off=${verdict.code === "permission-not-granted"}
            />
          </dt>
          <dd>
            <${VerdictMark} readable=${verdict.readable} />
            ${verdict.text ? html`<p>${verdict.text}</p>` : null}
          </dd>
        </div>`;
      })}
    </dl>
  </section>`;
}

/** What the page says under its title, given the gateway's answer. */
export function DocumentAccessReport({ audit, documentId }) {
  return html`
    <p class="doc-access-subject">
      <a
        href=${`/portal/doc/${encodeURIComponent(documentId)}`}
        onClick=${(event) => {
          event.preventDefault();
          navigate(`/portal/doc/${encodeURIComponent(documentId)}`);
        }}
      >${audit.title || "Untitled"}</a>
      <span class="doc-access-source">
        <span class="doc-access-source-icon" aria-hidden="true">${sourceIcon(audit.sourceId)}</span>
        ${[audit.sourceName, sourceAccountOf(audit.sourceId)].filter(Boolean).join(" · ")}
      </span>
    </p>
    <div class="doc-access-notes">
      ${audit.notes?.answer ? html`<p>${audit.notes.answer}</p>` : null}
      ${audit.notes?.owner ? html`<p>${audit.notes.owner}</p>` : null}
    </div>
    ${audit.levels?.length
      ? html`<div class="doc-access-levels">
          ${audit.levels.map((level) => html`<${LevelVerdicts} key=${level.id} level=${level} />`)}
        </div>`
      : html`<p class="doc-access-empty">There are no access levels, so no agent can read this document.</p>`}
  `;
}

export function DocumentAccessView({ id }) {
  const [state, setState] = useState({ loading: true, audit: null, error: "", missing: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, audit: null, error: "", missing: false });
    getDocumentAccess(id, controller.signal)
      .then((audit) => {
        if (!controller.signal.aborted)
          setState({ loading: false, audit, error: "", missing: false });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState({
          loading: false,
          audit: null,
          missing: error?.status === 404,
          error: error?.serverMessage || "This page could not be loaded.",
        });
      });
    return () => controller.abort();
  }, [id, attempt]);
  const back = `/portal/doc/${encodeURIComponent(id)}`;
  return html`<div class="doc-access-view">
    <div class="doc-toolbar">
      <a
        class="doc-back"
        href=${back}
        onClick=${(event) => {
          event.preventDefault();
          navigate(back);
        }}
        >← Back to document</a
      >
    </div>
    <div class="doc-access-page">
      <h1 class="doc-access-title">Who can read this?</h1>
      ${state.loading
        ? html`<p class="doc-access-loading" role="status"><span class="spinner"></span>Checking each access level…</p>`
        : state.missing
          ? html`<p class="doc-access-empty" role="alert">This document no longer exists.</p>`
          : state.error
            ? html`<div class="doc-access-error" role="alert">
                <p>${state.error}</p>
                <button type="button" class="btn-secondary" onClick=${() => setAttempt((value) => value + 1)}>
                  Try again
                </button>
              </div>`
            : html`<${DocumentAccessReport} audit=${state.audit} documentId=${id} />`}
    </div>
  </div>`;
}
