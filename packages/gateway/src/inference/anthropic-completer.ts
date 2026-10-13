// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * AnthropicCompleter — API-based text generation via Anthropic Messages API.
 * The sampling temperature goes through `AnthropicTemperature`, which stops
 * sending it once a model refuses it.
 */

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicTemperature, NO_THINKING, responseText } from "./anthropic-messages.js";
import type { CompleteCapability } from "@omnesis/core";

export class AnthropicCompleter implements CompleteCapability {
  readonly name = "anthropic";
  readonly modelId: string;
  private client: Anthropic;
  private readonly temperature = new AnthropicTemperature();

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
    const request = {
      model: this.modelId,
      max_tokens: opts?.maxTokens ?? 150,
      thinking: NO_THINKING,
      // Anthropic's API caps `stop_sequences` at 4 entries and rejects the
      // request outright past that, so truncate rather than fail a call whose
      // caller legitimately passed more.
      ...(opts?.stop && opts.stop.length > 0 ? { stop_sequences: [...opts.stop].slice(0, 4) } : {}),
      messages: [{ role: "user" as const, content: prompt }],
    };
    const response = await this.temperature.send(opts?.temperature ?? 0.3, (temperature) =>
      this.client.messages.create(
        temperature === undefined ? request : { ...request, temperature },
      ),
    );

    return responseText(response);
  }

  async dispose(): Promise<void> {
    // No-op — stateless HTTP client
  }
}
