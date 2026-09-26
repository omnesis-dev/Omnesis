// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { ProviderIcon } from "../../components/provider-icon.js";

/** The same bundled logos identify common agents in setup and connection lists. */
export const AGENT_ICONS = {
  "claude-code": { src: "/portal/img/agents/claude.svg" },
  codex: { providerId: "openai" },
  chatgpt: { providerId: "openai" },
  "claude-apps": { src: "/portal/img/agents/claude.svg" },
  antigravity: { src: "/portal/img/agents/antigravity.svg" },
  openclaw: { src: "/portal/img/agents/openclaw.svg" },
  hermes: { src: "/portal/img/agents/hermes.png" },
};

const APP_ALIASES = new Map([
  ["chatgpt", "chatgpt"],
  ["claude", "claude-apps"],
  ["claude apps", "claude-apps"],
  ["claude desktop", "claude-apps"],
  ["claude code", "claude-code"],
  ["claude cli", "claude-code"],
  ["codex", "codex"],
  ["codex cli", "codex"],
  ["codex cli rs", "codex"],
  ["antigravity", "antigravity"],
  ["openclaw", "openclaw"],
  ["hermes", "hermes"],
  ["hermes agent", "hermes"],
]);

/** Match the client-reported app name, never an owner-editable connection name. */
export function agentIconForApp(name) {
  if (typeof name !== "string") return null;
  const alias = name.trim().toLowerCase().replace(/[\s_-]+/gu, " ");
  const id = APP_ALIASES.get(alias)
    ?? (/^(?:openai|chatgpt|codex)\b/u.test(alias) ? "chatgpt"
      : /^(?:anthropic|claude)\b/u.test(alias) ? "claude-apps"
        : /^(?:google )?antigravity\b/u.test(alias) ? "antigravity"
          : /^openclaw\b/u.test(alias) ? "openclaw"
            : /^hermes\b/u.test(alias) ? "hermes" : null);
  return id ? AGENT_ICONS[id] : null;
}

export function AgentIcon({ icon, size = 22 }) {
  return icon.providerId
    ? html`<${ProviderIcon} providerId=${icon.providerId} size=${size} />`
    : html`<img src=${icon.src} alt="" width=${size} height=${size} />`;
}
