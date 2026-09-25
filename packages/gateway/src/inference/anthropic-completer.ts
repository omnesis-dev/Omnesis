// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * AnthropicCompleter — API-based text generation via Anthropic Messages API.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { CompleteCapability } from "@omnesis/core";

export class AnthropicCompleter implements CompleteCapability {
  readonly name = "anthropic";
  readonly modelId: string;
  private client: Anthropic;

  constructor(modelId: string, apiKey: string) {
    this.modelId = modelId;
    this.client = new Anthropic({ apiKey });
  }

  async complete(
    prompt: string,
    opts?: {
      maxTokens?: number;
      temperature?: number;
      stop?: readonly string[];
    },
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: opts?.maxTokens ?? 150,
      temperature: opts?.temperature ?? 0.3,
      // Anthropic's API caps `stop_sequences` at 4 entries and rejects the
      // request outright past that, so truncate rather than fail a call whose
      // caller legitimately passed more.
      ...(opts?.stop && opts.stop.length > 0 ? { stop_sequences: [...opts.stop].slice(0, 4) } : {}),
      messages: [{ role: "user", content: prompt }],
    });

    const block = response.content[0];
    return block.type === "text" ? block.text : "";
  }

  async dispose(): Promise<void> {
    // No-op — stateless HTTP client
  }
}
