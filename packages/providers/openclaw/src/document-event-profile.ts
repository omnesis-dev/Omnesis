// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DocumentEventProfile } from "@omnesis/source-sdk";

/**
 * What a watch condition can address on an OpenClaw transcript.
 *
 * One `conversation` document covers one chat on one calendar day: the day's
 * turns rendered as a running transcript. The agent's own replies are body
 * text, never people, so `participant` only ever resolves to the operator —
 * a person predicate over this source cannot name anyone else.
 *
 * Only fields the push path actually writes are declared. Three exclusions are
 * deliberate:
 *
 *   - `chatName` and `chatType` are part of the `/agent-messages` wire
 *     protocol, but this harness derives its conversation identity from the
 *     session key and sends neither, so every OpenClaw document carries them
 *     as null. Declaring them would let the compiler build a predicate that
 *     can never match — the failure this profile exists to prevent.
 *   - `extra.harness` and `extra.provenance` are populated but hold the same
 *     constant on every document, as `metadata.rollingAggregate` does. A
 *     condition over any of them cannot discriminate.
 */
export const openClawDocumentEventProfile: DocumentEventProfile = {
  documentTypes: ["conversation"],
  personRoles: ["participant"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description:
        "Always two tags: the harness that produced the transcript ('openclaw') and the surface the conversation happened on, matching extra.channel.",
      canonicalValues: [
        "openclaw",
        "local",
        "slack",
        "discord",
        "whatsapp",
        "telegram",
        "signal",
        "imessage",
        "matrix",
        "mattermost",
      ],
    },
    {
      path: "extra.agent",
      type: "string",
      description:
        "Display name of the agent that held the conversation. Always 'OpenClaw' on this source.",
      allowedValues: ["OpenClaw"],
      valueAliases: { OpenClaw: ["openclaw", "open claw", "the OpenClaw agent"] },
    },
    {
      path: "extra.channel",
      type: "string",
      description:
        "Surface the conversation took place on: 'local' for a session held directly on the host machine, or the messaging platform the harness was reached through. Always present.",
      canonicalValues: [
        "local",
        "slack",
        "discord",
        "whatsapp",
        "telegram",
        "signal",
        "imessage",
        "matrix",
        "mattermost",
      ],
      valueAliases: {
        local: ["on my machine", "on the host", "locally", "terminal"],
        slack: ["on Slack", "via Slack"],
        discord: ["on Discord", "via Discord"],
        whatsapp: ["on WhatsApp", "via WhatsApp"],
      },
    },
    {
      path: "extra.chatId",
      type: "string",
      // A direct-message identifier singles out the person on the other end,
      // so a filter on it names a human even though a channel identifier does
      // not.
      identifiesPeople: true,
      description:
        "Identifier the channel uses for this conversation — a channel id, a direct-message id, or 'main' for a session held on the host machine. Opaque and platform-specific. Absent when the channel reported no conversation identity.",
    },
    {
      path: "extra.messageCount",
      type: "number",
      description: "Number of turns exchanged in this conversation on this day.",
    },
  ],
};
