// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The part of OpenClaw's transcript runtime this plugin reads. OpenClaw keeps
 * `openclaw/plugin-sdk/session-transcript-runtime` as a JavaScript export for
 * plugin runtimes, and its plugin runtime guide still names it the transcript
 * read path, but later releases no longer ship its type declarations. The one
 * function used here is declared with the shape every supported release
 * accepts and returns.
 *
 * See #114 — move to a public OpenClaw transcript API once one exists.
 */
declare module "openclaw/plugin-sdk/session-transcript-runtime" {
  export interface SessionTranscriptReadParams {
    agentId?: string;
    sessionKey: string;
    sessionId: string;
  }

  /** Every durable event of one session transcript, oldest first. */
  export function readSessionTranscriptEvents(
    params: SessionTranscriptReadParams,
  ): Promise<unknown[]>;
}
