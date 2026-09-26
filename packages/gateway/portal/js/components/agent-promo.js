// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Agent promo — the card on the Sources page that suggests connecting an
// agent such as Claude or ChatGPT. It shows only while the gateway can take a
// connection (its OAuth address is set) and no agent holds one, and it opens
// the Connect an agent dialog on the Access tab rather than a modal of its
// own: that dialog already carries each agent's setup.

import { html } from "htm/preact";
import { useEffect, useState } from "preact/hooks";
import { getAccessOverview } from "../api.js";
import { navigate } from "../lib/router.js";
import { ProviderIcon } from "./provider-icon.js";

export const AGENT_CONNECT_PATH = "/portal/settings/access/connect";

/** The marks of the agents the Connect an agent dialog gives setup for. */
const AGENT_MARKS = [
  { name: "Claude", src: "/portal/img/agents/claude.svg" },
  { name: "ChatGPT and Codex", providerId: "openai" },
  { name: "Antigravity", src: "/portal/img/agents/antigravity.svg" },
  { name: "OpenClaw", src: "/portal/img/agents/openclaw.svg" },
  { name: "Hermes", src: "/portal/img/agents/hermes.png" },
];

/** Whether the access overview leaves an agent to connect and a way to connect it. */
export function shouldShowAgentPromo(overview) {
  if (!overview?.oauth) return false;
  return !(overview.principals ?? []).some((principal) => principal.revokedAt == null);
}

/**
 * Reads the access overview once and says whether the card belongs on the
 * page. Until it answers, or when it cannot, the card stays hidden: a
 * suggestion is never worth an error.
 */
export function useAgentPromoVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let live = true;
    getAccessOverview()
      .then((overview) => { if (live) setVisible(shouldShowAgentPromo(overview)); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return visible;
}

export function AgentPromoCard() {
  return html`
    <section class="ext-promo agent-promo" aria-label="Connect an agent">
      <span class="agent-promo-marks">
        ${AGENT_MARKS.map((mark) => mark.providerId
          ? html`<${ProviderIcon} key=${mark.name} providerId=${mark.providerId} size=${16} />`
          : html`<img key=${mark.name} src=${mark.src} alt="" title=${mark.name} width="16" height="16" />`)}
      </span>
      <div class="ext-promo-body">
        <strong class="ext-promo-title">Connect your favorite agent</strong>
        <p class="ext-promo-text">Claude, ChatGPT, Codex and more can ask Omnesis.</p>
      </div>
      <a
        class="ext-promo-open agent-promo-connect"
        href=${AGENT_CONNECT_PATH}
        onClick=${(event) => {
          event.preventDefault();
          navigate(AGENT_CONNECT_PATH);
        }}
      >Connect</a>
    </section>
  `;
}
