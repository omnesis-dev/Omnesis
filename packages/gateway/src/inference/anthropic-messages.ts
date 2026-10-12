// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What every one-shot Anthropic Messages call in the gateway shares: no
 * extended thinking, a sampling temperature sent only while the model accepts
 * it, and the reply's text read from every text block.
 */

import Anthropic from "@anthropic-ai/sdk";

/**
 * A one-shot call asks for a direct answer within a budget sized for it. A model
 * that thinks by default would spend that budget thinking and return no text.
 */
export const NO_THINKING: Anthropic.ThinkingConfigDisabled = { type: "disabled" };

/**
 * Newer models reject the sampling temperature outright with a 400; the first
 * such rejection is retried without it, and the parameter is never sent again
 * through this instance.
 */
export class AnthropicTemperature {
  private accepted = true;

  /** Run `send` with `temperature`, or without it once the model has refused one. */
  async send<T>(
    temperature: number | undefined,
    send: (temperature: number | undefined) => Promise<T>,
  ): Promise<T> {
    const sent = this.accepted ? temperature : undefined;
    try {
      return await send(sent);
    } catch (err) {
      if (sent === undefined || !rejectsTemperature(err)) throw err;
      this.accepted = false;
      return send(undefined);
    }
  }
}

/** A 400 whose message names the `temperature` parameter. */
function rejectsTemperature(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIError && err.status === 400 && /\btemperature\b/.test(err.message)
  );
}

/** The reply's text: every text block, in order; thinking and tool blocks are skipped. */
export function responseText(response: Pick<Anthropic.Message, "content">): string {
  return response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}
