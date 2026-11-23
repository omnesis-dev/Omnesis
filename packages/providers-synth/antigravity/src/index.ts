// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import realSource from "@omnesis/provider-antigravity";
import { defineSource } from "@omnesis/source-sdk";
import {
  fakeLocalFlow,
  loadActiveUniverse,
  loadSourceFixtureJson,
  materializeSyntheticFiles,
  preDiscoveredAccounts,
  universeAccounts,
} from "@omnesis/providers-synth-common";

const sessionSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    prompt: z.string().min(1),
    answer: z.string().min(1),
    model: z.string().optional(),
  })
  .strict();

export type SessionFixture = z.infer<typeof sessionSchema>;

export function loadSessions(): SessionFixture[] {
  return z
    .array(sessionSchema)
    .parse(loadSourceFixtureJson<unknown>(loadActiveUniverse(), "antigravity", "sessions.json"));
}

export function sessionRecords(session: SessionFixture): Record<string, unknown>[] {
  return [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: session.createdAt,
      content: `<USER_REQUEST>\n${session.prompt}\n</USER_REQUEST>`,
    },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: session.createdAt,
      model: session.model ?? "gemini-4-neon-high",
      content: session.answer,
    },
  ];
}

const { type: _type, ...rest } = realSource;

/** Real parsing/normalization over invented, isolated input files; no default host roots. */
export default defineSource({
  ...rest,
  contract: {
    ...realSource.contract,
    state: {
      version: 1,
      decode: realSource.contract!.state!.decode,
      maxBytes: 20 * 1024 * 1024,
      onUnreadable: "rebootstrap",
    },
  },
  config: undefined,
  params: undefined,
  resolveAccountId: undefined,
  supportedPlatforms: undefined,
  credentials: undefined,
  authenticate: undefined,
  cleanupCredentials: undefined,
  discover: async () => preDiscoveredAccounts("antigravity", universeAccounts("antigravity")),
  authFlow: async () =>
    fakeLocalFlow("antigravity", universeAccounts("antigravity")[0] ?? "synthetic"),
  async create(options) {
    const root = materializeSyntheticFiles(
      options.host?.stateDir,
      "antigravity",
      loadSessions().map((session) => ({
        path: `brain/${session.id}/.system_generated/logs/transcript_full.jsonl`,
        content:
          sessionRecords(session)
            .map((record) => JSON.stringify(record))
            .join("\n") + "\n",
      })),
    );
    return realSource.create!({ ...options, config: { antigravityHome: root } });
  },
});
