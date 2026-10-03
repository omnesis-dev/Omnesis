// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import realSource from "@omnesis/provider-pi";
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
    .parse(loadSourceFixtureJson<unknown>(loadActiveUniverse(), "pi", "sessions.json"));
}
export function sessionRecords(session: SessionFixture): Record<string, unknown>[] {
  return [
    {
      type: "session",
      version: 3,
      id: session.id,
      timestamp: session.createdAt,
      cwd: session.project ?? "/fictional-project",
    },
    {
      type: "message",
      id: `${session.id}-user`,
      parentId: null,
      timestamp: session.createdAt,
      message: {
        role: "user",
        timestamp: Date.parse(session.createdAt),
        content: [{ type: "text", text: session.prompt }],
      },
    },
    {
      type: "message",
      id: `${session.id}-answer`,
      parentId: `${session.id}-user`,
      timestamp: session.createdAt,
      message: {
        role: "assistant",
        timestamp: Date.parse(session.createdAt),
        stopReason: "stop",
        content: [{ type: "text", text: session.answer }],
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
  discover: async () => preDiscoveredAccounts("pi", universeAccounts("pi")),
  authFlow: async () => fakeLocalFlow("pi", universeAccounts("pi")[0] ?? "synthetic"),
  async create(options) {
    const root = materializeSyntheticFiles(
      options.host?.stateDir,
      "pi",
      loadSessions().map((session) => ({
        path: `${session.id}.jsonl`,
        content:
          sessionRecords(session)
            .map((record) => JSON.stringify(record))
            .join("\n") + "\n",
      })),
    );
    return realSource.create!({ ...options, config: { sessionsPath: root } });
  },
});
