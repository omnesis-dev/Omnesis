// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { createLogger } from "@omnesis/core";
import type { ToolHandle } from "@omnesis/agent";

export interface ConversationMemoryEvidence {
  documentId: string;
  userMessages: string[];
  /** Older text was omitted from this bounded evidence preview. */
  truncated?: boolean;
}

const log = createLogger("gateway:agent").child("memory");
const schema = z.object({}).strict();

/** The session supplies the evidence; the model cannot supply a transcript or speaker. */
export function buildConversationMemoryEvidenceTool(
  prepare: () => Promise<ConversationMemoryEvidence | null>,
): ToolHandle {
  return {
    name: "conversation_memory_evidence",
    description:
      "Persist this conversation and obtain its evidence document ID and user-authored messages for durable memory. Quote only the returned user text when remembering something the user told you. Takes no arguments. If unavailable, do not claim the memory was saved.",
    schema,
    mutates: true,
    async invoke(args) {
      if (!schema.safeParse(args).success) {
        return { kind: "error", code: "invalid_args", message: "This tool takes no arguments." };
      }
      try {
        const evidence = await prepare();
        if (evidence && evidence.userMessages.length > 0) {
          return { kind: "structured", resultType: "memory.conversation_evidence", data: evidence };
        }
      } catch {
        log.warn("conversation memory evidence could not be persisted");
      }
      return {
        kind: "error",
        code: "memory_evidence_unavailable",
        message:
          "No persisted user-message evidence is available. Conversation indexing must be available to remember facts from this chat. Do not claim the memory was saved.",
      };
    },
  };
}
