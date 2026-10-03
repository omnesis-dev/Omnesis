// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import realSource from "@omnesis/provider-codex";
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
    project: z.string().optional(),
  })
  .strict();
export type SessionFixture = z.infer<typeof sessionSchema>;
export function loadSessions(): SessionFixture[] {
  return z
    .array(sessionSchema)
    .parse(loadSourceFixtureJson<unknown>(loadActiveUniverse(), "codex", "sessions.json"));
}
export function sessionRecords(session: SessionFixture): Record<string, unknown>[] {
  return [
    {
      type: "session_meta",
      timestamp: session.createdAt,
      payload: { id: session.id, source: "cli", cwd: session.project ?? "/fictional-project" },
    },
    {
      type: "event_msg",
      timestamp: session.createdAt,
      payload: { type: "user_message", message: session.prompt },
    },
    {
      type: "response_item",
      timestamp: session.createdAt,
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: session.answer }],
      },
    },
  ];
}

const { type: _type, ...rest } = realSource;
/** Real parsing/normalization over invented, isolated input files; no default host roots. */
export default defineSource({
  ...rest,
  config: undefined,
  params: undefined,
  resolveAccountId: undefined,
  supportedPlatforms: undefined,
  credentials: undefined,
  authenticate: undefined,
  cleanupCredentials: undefined,
  discover: async () => preDiscoveredAccounts("codex", universeAccounts("codex")),
  authFlow: async () => fakeLocalFlow("codex", universeAccounts("codex")[0] ?? "synthetic"),
  async create(options) {
    const root = materializeSyntheticFiles(
      options.host?.stateDir,
      "codex",
      loadSessions().map((session) => ({
        path: `sessions/${session.id}.jsonl`,
        content:
          sessionRecords(session)
            .map((record) => JSON.stringify(record))
            .join("\n") + "\n",
      })),
    );
    return realSource.create!({ ...options, config: { codexHome: root } });
  },
});
