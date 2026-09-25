// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP surface of the pushed agent-conversation sources. `POST /agent-messages`
 * accepts a batch of raw turns pushed by a harness plugin (OpenClaw / Hermes)
 * and appends them to the `agent_messages` ledger; a debounced projector renders
 * each touched (harness, channel, chat, day) bucket into a corpus document using
 * the same shared renderer the collector-hosted reader sources use.
 *
 * Auth: `scope.writeAny()` plus a per-harness refinement — the token must hold
 * `write:<harness>` (or admin / `write:*`) for every distinct harness in the
 * batch. A plugin's scoped `write:openclaw` token can push only OpenClaw turns.
 */

import { agentMessagesRateLimiter } from "../../rate-limit.js";
import { enforceWriteScopeForSource, scope } from "../scope.js";
import { validateJson } from "../validate.js";
import { ingestAgentMessagesBody } from "../schemas/agent-messages.js";
import { clientIp, isLoopbackRequest } from "./admin/internals.js";
import type { AgentConversationsRuntime } from "../../sources/agent-conversations/index.js";
import type { RouteApp } from "./types.js";

export interface AgentMessagesRoutesDeps {
  runtime: AgentConversationsRuntime;
}

export function mountAgentMessagesRoutes(app: RouteApp, deps: AgentMessagesRoutesDeps): void {
  const limiter = agentMessagesRateLimiter();

  app.post(
    "/agent-messages",
    scope.writeAny(),
    validateJson(ingestAgentMessagesBody),
    async (c) => {
      if (!isLoopbackRequest(c) && limiter.consume(clientIp(c))) {
        return c.json({ error: "Too many push requests — try again later" }, 429, {
          "Retry-After": "60",
        });
      }
      const auth = c.get("auth");
      const body = c.req.valid("json");
      // Per-harness scope refinement: the token must be allowed to write every
      // distinct harness present in the batch.
      const harnesses = new Set(body.messages.map((m) => m.harness));
      for (const harness of harnesses) {
        enforceWriteScopeForSource(auth.scopes, `${harness}:local`);
      }
      const result = await deps.runtime.ingest(body.messages);
      return c.json(result, 202);
    },
  );
}
