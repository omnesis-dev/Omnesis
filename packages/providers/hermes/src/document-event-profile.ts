// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DocumentEventProfile } from "@omnesis/source-sdk";

/**
 * What a watch condition can address on a Hermes transcript.
 *
 * One `conversation` document covers one chat on one calendar day: the day's
 * turns rendered as a running transcript. The agent's own replies are body
 * text, never people, so `participant` only ever resolves to the operator —
 * a person predicate over this source cannot name anyone else.
 *
 * Only fields the push path actually writes are declared. `extra.harness` and
 * `extra.provenance` are also populated but hold the same constant on every
 * document, so a condition over either would say nothing that the source
 * itself does not already say; `metadata.rollingAggregate` is likewise always
 * true. Declaring them would spend the model's attention on filters that
 * cannot discriminate.
 *
 * This harness reports a conversation's display name and shape, so both are
 * declared here — unlike OpenClaw, which derives identity from its session key
 * and sends neither.
 */
export const hermesDocumentEventProfile: DocumentEventProfile = {
  documentTypes: ["conversation"],
  personRoles: ["participant"],
  metadataFields: [
    {
      path: "tags",
      type: "string-array",
      description:
        "Always two tags: the harness that produced the transcript ('hermes') and the surface the conversation happened on, matching extra.channel.",
      canonicalValues: [
        "hermes",
        "cli",
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
        "Display name of the agent that held the conversation. Always 'Hermes' on this source.",
      allowedValues: ["Hermes"],
      valueAliases: { Hermes: ["hermes", "the Hermes agent"] },
    },
    {
      path: "extra.channel",
      type: "string",
      description:
        "Surface the conversation took place on: 'cli' for a session held at the terminal, or the messaging platform the agent was reached through. Always present.",
      canonicalValues: [
        "cli",
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
        cli: ["at the terminal", "on the command line", "locally"],
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
        "Identifier the channel uses for this conversation — a channel id or a direct-message id. Opaque and platform-specific. Absent for a terminal session and whenever the channel reported no conversation identity.",
    },
    {
      path: "extra.chatName",
      type: "string",
      identifiesPeople: true,
      description:
        "Human-readable name of the conversation, such as a channel name or the name of the person in a direct message. Absent whenever the channel did not report one, which is most conversations.",
    },
    {
      path: "extra.chatType",
      type: "string",
      description:
        "Shape of the conversation as the channel reported it. Absent when the channel did not report one.",
      canonicalValues: ["dm", "direct", "group"],
      valueAliases: {
        dm: ["a direct message", "a DM", "one-to-one", "private"],
        group: ["a group", "a channel", "a room"],
      },
    },
    {
      path: "extra.messageCount",
      type: "number",
      description: "Number of turns exchanged in this conversation on this day.",
    },
  ],
};
