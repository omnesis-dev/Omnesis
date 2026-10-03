// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import realSource from "@omnesis/provider-claude-code";
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
    .parse(loadSourceFixtureJson<unknown>(loadActiveUniverse(), "claude-code", "sessions.json"));
}
export function sessionRecords(session: SessionFixture): Record<string, unknown>[] {
  return [
    {
      type: "user",
      uuid: `${session.id}-user`,
      parentUuid: null,
      sessionId: session.id,
      timestamp: session.createdAt,
      cwd: session.project ?? "/fictional-project",
      isSidechain: false,
      userType: "external",
      message: { role: "user", content: session.prompt },
    },
    {
      type: "assistant",
      uuid: `${session.id}-answer`,
      parentUuid: `${session.id}-user`,
      sessionId: session.id,
      timestamp: session.createdAt,
      cwd: session.project ?? "/fictional-project",
      isSidechain: false,
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: session.answer }],
      },
    },
  ];
}

const { type: _type, ...rest } = realSource;
/** Real parsing/normalization over invented, isolated input files; no default host roots. */
export default defineSource({
  ...rest,
  // The native reader writes the same cursor shape. Declare an independent
  // synthetic boundary while retaining its validator and envelope generation.
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
  discover: async () => preDiscoveredAccounts("claude-code", universeAccounts("claude-code")),
  authFlow: async () =>
    fakeLocalFlow("claude-code", universeAccounts("claude-code")[0] ?? "synthetic"),
  async create(options) {
    const root = materializeSyntheticFiles(
      options.host?.stateDir,
      "claude-code",
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
